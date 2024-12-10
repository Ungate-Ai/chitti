// packages/client-twitter-api/src/base.ts
import {
    Content,
    IAgentRuntime,
    IImageDescriptionService,
    embeddingZeroVector,
    Memory,
    State,
    elizaLogger,
    stringToUuid,
    UUID,
} from "@ai16z/eliza";
import { TwitterApi } from "twitter-api-v2";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { glob } from "glob";

export function extractAnswer(text: string): string {
    const startIndex = text.indexOf("Answer: ") + 8;
    const endIndex = text.indexOf("<|endoftext|>", 11);
    return text.slice(startIndex, endIndex);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class RequestQueue {
    private queue: (() => Promise<any>)[] = [];
    private processing: boolean = false;
    private rateLimitReset: number | null = null;

    async add<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await request();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) {
            return;
        }
        this.processing = true;

        while (this.queue.length > 0) {
            const request = this.queue.shift()!;
            try {
                await request();
            } catch (error) {
                console.error("Error processing request:", error);
                this.queue.unshift(request);
                await this.exponentialBackoff(this.queue.length);
            }
            await this.randomDelay();
        }

        this.processing = false;
    }

    private async exponentialBackoff(retryCount: number): Promise<void> {
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    private async randomDelay(): Promise<void> {
        const delay = Math.floor(Math.random() * 2000) + 1500;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    private async handleRateLimit(): Promise<void> {
        if (this.rateLimitReset) {
            const now = Math.floor(Date.now() / 1000);
            const waitTime = (this.rateLimitReset - now) * 1000 + 1000; // Add 1 second buffer
            console.log(`Waiting for ${waitTime}ms before retrying...`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            this.rateLimitReset = null;
        } else {
            // If no reset time provided, use exponential backoff
            await this.exponentialBackoff(this.queue.length);
        }
    }
}

export type Tweet = {
    id: string;
    text: string;
    conversationId: string;
    createdAt: string;
    userId: string;
    inReplyToStatusId?: string;
    permanentUrl: string;
    username?: string;
    name?: string;
    hashtags: any[];
    mentions: any[];
    photos: any[];
    thread: {
        type: "reply" | "retweet" | "quote";
        tweet: Tweet;
    }[];
    urls: string[];
    videos: any[];
    timestamp: number;
};

export enum SearchMode {
    Latest = "Latest",
    Top = "Top",
}

export class ClientBase extends EventEmitter {
    protected isReady: boolean = false;
    protected readyPromise: Promise<void>;
    static _twitterClient: TwitterApi;
    twitterClient: TwitterApi;
    runtime: IAgentRuntime;
    directions: string;
    lastCheckedTweetId: number | null = null;
    tweetCacheFilePath = __dirname + "/tweetcache/latest_checked_tweet_id.txt";
    imageDescriptionService: IImageDescriptionService;
    temperature: number = 0.5;

    private tweetCache: Map<string, Tweet> = new Map();
    requestQueue: RequestQueue = new RequestQueue();
    twitterUserId: string;
    twitterUsername: string;
    twitterName: string;
    twitterDescription: string;
    protected twitterAccessToken: string;
    protected twitterRefreshToken: string;

    onReady() {
        throw new Error(
            "Not implemented in base class, please call from subclass"
        );
    }

    protected async ensureReady(): Promise<void> {
        if (!this.isReady) {
            await this.readyPromise;
        }
        if (!this.twitterUsername || !this.twitterUserId) {
            throw new Error("Twitter client not properly initialized");
        }
    }

    protected async getAuthenticatedUserInfo() {
        return await this.executeWithTokenRefresh(async () => {
            const me = await this.twitterClient.v2.me({
                "user.fields": ["username", "name", "id", "description"],
            });
            return {
                id: me.data.id,
                username: me.data.username,
                name: me.data.name,
            };
        });
    }

    private async refreshTwitterToken(): Promise<void> {
        try {
            const baseClient = new TwitterApi({
                clientId: this.runtime.getSetting("TWITTER_CLIENT_ID") ,
                clientSecret: this.runtime.getSetting("TWITTER_CLIENT_SECRET"),
            });

            //#db Bring a database connection here and fetch the refresh token
            const existingRefreshToken =
                await this.runtime.databaseAdapter.getTwitterRefreshToken(
                    this.runtime.agentId
                );
            const {
                client: refreshedClient,
                accessToken,
                refreshToken: newRefreshToken,
            } = await baseClient.refreshOAuth2Token(existingRefreshToken);

            await this.runtime.databaseAdapter.updateTwitterAccessToken(
                this.runtime.agentId,
                accessToken,
                newRefreshToken
            );

            this.twitterClient = refreshedClient;
            ClientBase._twitterClient = refreshedClient;
            //#db Bring a database connection here and update the access token and refresh token
            this.twitterAccessToken = accessToken;
            this.twitterRefreshToken = newRefreshToken;

            console.log("Successfully refreshed Twitter tokens");
        } catch (error) {
            console.error("Error refreshing Twitter token:", error);
            throw error;
        }
    }

    private async executeWithTokenRefresh<T>(
        operation: () => Promise<T>
    ): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            console.log("Operation failed:", error.code, error.message);
            if (
                error.code === 401 ||
                (error.message && error.message.includes("token"))
            ) {
                console.log("Token expired, attempting refresh...");
                await this.refreshTwitterToken();
                return await operation();
            }
            if (error.code === 429) {
                const waitTime = 25 * 60 * 60 * 1000;
                console.log(`Rate limited. Waiting ${waitTime} ms before retrying...`);
                await new Promise((resolve) =>
                    setTimeout(resolve, waitTime + 1000)
                );
                return await operation();
            }
            throw error;
        }
    }

    async cacheTweet(tweet: Tweet): Promise<void> {
        if (!tweet) {
            console.warn("Tweet is undefined, skipping cache");
            return;
        }
        const cacheDir = path.join(
            __dirname,
            "tweetcache",
            tweet.conversationId,
            `${tweet.id}.json`
        );
        await fs.promises.mkdir(path.dirname(cacheDir), { recursive: true });
        await fs.promises.writeFile(cacheDir, JSON.stringify(tweet, null, 2));
        this.tweetCache.set(tweet.id, tweet);
    }

    async getCachedTweet(tweetId: string): Promise<Tweet | undefined> {
        if (this.tweetCache.has(tweetId)) {
            return this.tweetCache.get(tweetId);
        }

        const cacheFile = path.join(
            __dirname,
            "tweetcache",
            "*",
            `${tweetId}.json`
        );
        const files = await glob(cacheFile);
        if (files.length > 0) {
            const tweetData = await fs.promises.readFile(files[0], "utf-8");
            const tweet = JSON.parse(tweetData) as Tweet;
            this.tweetCache.set(tweet.id, tweet);
            return tweet;
        }

        return undefined;
    }

    async getTweet(tweetId: string): Promise<Tweet> {
        await this.ensureReady();
        const cachedTweet = await this.getCachedTweet(tweetId);
        if (cachedTweet) {
            return cachedTweet;
        }

        const result = await this.executeWithTokenRefresh(async () => {
            //const tweetResult = await this.twitterClient.v2.get(`tweets/${tweetId}`);
            const tweetResult = await this.twitterClient.v2.singleTweet(
                tweetId,
                {
                    "tweet.fields": [
                        "created_at",
                        "conversation_id",
                        "in_reply_to_user_id",
                        "entities",
                        "attachments",
                        "referenced_tweets",
                        "text",
                    ],
                    "user.fields": ["name", "username"],
                    expansions: [
                        "author_id",
                        "attachments.media_keys",
                        "referenced_tweets.id",
                        "entities.mentions.username",
                    ],
                    "media.fields": [
                        "url",
                        "type",
                        "preview_image_url",
                        "alt_text",
                    ],
                }
            );
            const tweet: Tweet = {
                id: tweetResult.data.id,
                text: tweetResult.data.text,
                conversationId:
                    tweetResult.data.conversation_id || tweetResult.data.id, // Using tweet id as conversation id if not available
                createdAt: new Date().toISOString(), // Using current time as created_at is not in basic response
                userId: tweetResult.data.author_id,
                inReplyToStatusId: tweetResult.data.in_reply_to_user_id,
                permanentUrl: `https://twitter.com/i/web/status/${tweetResult.data.id}`,
                username: tweetResult.includes?.users?.find(
                    (user) => user.id === tweetResult.data.author_id
                ).username,
                name: tweetResult.includes?.users?.find(
                    (user) => user.id === tweetResult.data.author_id
                ).name,
                hashtags: tweetResult.data.entities.hashtags,
                mentions: tweetResult.data.entities.mentions,
                photos: [],
                thread: [],
                urls: tweetResult.data.entities.urls.map((url) => url.url),
                videos: [],
                timestamp: tweetResult.data.created_at
                    ? new Date(tweetResult.data.created_at).getTime() / 1000
                    : Date.now() / 1000,
            };

            return tweet;
        });

        await this.cacheTweet(result);
        return result;
    }

    callback: (self: ClientBase) => any = null;

    constructor({ runtime }: { runtime: IAgentRuntime }) {
        super();
        this.runtime = runtime;
        console.log("ClientBase");

        (async () => {
            if (ClientBase._twitterClient) {
                this.twitterClient = ClientBase._twitterClient;
            } else {
                const accessToken =
                await this.runtime.databaseAdapter.getTwitterAccessToken(
                    this.runtime.agentId
                );
                
                console.log(accessToken)

                this.twitterAccessToken = accessToken;
                if (!accessToken) {
                    throw new Error("Twitter access token is required");
                }
                console.log(accessToken);
                this.twitterClient = new TwitterApi(accessToken);
                console.log(this.twitterClient || "none");
                ClientBase._twitterClient = this.twitterClient;
            }
            this.directions =
            "- " +
            this.runtime.character.style.all.join("\n- ") +
            "- " +
            this.runtime.character.style.post.join();

        try {
            // console.log("this.tweetCacheFilePath", this.tweetCacheFilePath);
            if (fs.existsSync(this.tweetCacheFilePath)) {
                // make it?
                const data = fs.readFileSync(this.tweetCacheFilePath, "utf-8");
                this.lastCheckedTweetId = parseInt(data.trim());
            } else {
                // console.warn("Tweet cache file not found.");
                // console.warn(this.tweetCacheFilePath);
            }
        } catch (error) {
            console.error(
                "Error loading latest checked tweet ID from file:",
                error
            );
        }
        const cookiesFilePath = path.join(
            __dirname,
            "tweetcache/" + "username" + "_cookies.json"
        );

        const dir = path.dirname(cookiesFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // async initialization
        // Define readyPromise with its resolver
        this.readyPromise = new Promise<void>((resolve, reject) => {
            (async () => {
                // initiate twitter client
                try {
                    await this.executeWithTokenRefresh(async () => {
                        const me = await this.twitterClient.v2.me({
                            "user.fields": [
                                "username",
                                "name",
                                "id",
                                "description",
                            ],
                        });
                        this.twitterUserId = me.data.id;
                        console.log("Twitter user ID:", this.twitterUserId);
                        this.twitterUsername = me.data.username;
                        console.log("Twitter user Name:", this.twitterUsername);
                        this.twitterDescription = me.data.description;
                        console.log(
                            "Twitter user description:",
                            this.twitterDescription
                        );
                        this.twitterName = me.data.name;
                        console.log("Twitter Name:", this.twitterName);
                    });

                    const profile = await this.initializeProfile();
                    if (profile) {
                        console.log("Twitter profile initialized:", profile);

                        // Store profile info for use in responses
                        this.runtime.character = {
                            ...this.runtime.character,
                            twitterProfile: {
                                username: profile.username,
                                screenName: profile.screenName,
                                bio: profile.bio,
                                nicknames: profile.nicknames,
                            },
                        };
                    }

                    await this.populateTimeline();
                    this.isReady = true;
                    resolve();
                    this.onReady();
                } catch (error) {
                    console.error("Error initializing Twitter client:", error);
                    reject(error);
                }
            })();
        });
        })();

        
    }

    // initializeClientMain COde

    async fetchHomeTimeline(count: number): Promise<Tweet[]> {
        await this.ensureReady();
        return await this.executeWithTokenRefresh(async () => {
            try {
                const homeTimelineResult =
                    await this.twitterClient.v2.homeTimeline({
                        "tweet.fields": [
                            "created_at",
                            "conversation_id",
                            "in_reply_to_user_id",
                            "entities",
                            "attachments",
                            "referenced_tweets",
                            "text",
                        ],
                        "user.fields": ["name", "username"],
                        expansions: [
                            "author_id",
                            "attachments.media_keys",
                            "referenced_tweets.id",
                            "entities.mentions.username",
                        ],
                        "media.fields": [
                            "url",
                            "type",
                            "preview_image_url",
                            "alt_text",
                        ],
                        max_results: count, // Adjust the value as needed
                    });

                console.log("Fetched homeTimeline successfully");

                const tweets = homeTimelineResult.data.data;

                // Check if the data property exists and is an array
                if (!Array.isArray(tweets)) {
                    throw new Error(
                        "Expected tweets to be an array, but got:",
                        tweets
                    );
                }

                const mappedTweets: Tweet[] = [];

                tweets.forEach((tweet) => {
                    // Error handling for missing properties
                    try {
                        mappedTweets.push({
                            id: tweet.id,
                            text: tweet.text,
                            conversationId: tweet.conversation_id || null,
                            createdAt: tweet.created_at,
                            userId: tweet.author_id,
                            inReplyToStatusId:
                                tweet.in_reply_to_user_id || null,
                            permanentUrl: `https://twitter.com/${tweet.author_id}/status/${tweet.id}`,
                            username: null, // Assuming username is available in the response
                            name: null, // Assuming name is available in the response
                            hashtags: tweet.entities?.hashtags || [],
                            mentions: tweet.entities?.mentions || [],
                            photos: [],

                            // Populate the thread property
                            thread: [],

                            urls:
                                tweet.entities?.urls?.map(
                                    (url) => url.expanded_url
                                ) || [],
                            videos: [],
                            timestamp:
                                new Date(tweet.created_at).getTime() / 1000,
                        });
                    } catch (err) {
                        console.error("Error mapping tweet:", err);
                    }
                });

                return mappedTweets;
            } catch (error) {
                console.error("Error fetching home timeline:", error);
                throw error;
            }
        });
    }

    async fetchSearchTweets(
        query: string,
        maxTweets: number,
        searchMode: SearchMode
    ): Promise<{ tweets: Tweet[] }> {
        return await this.executeWithTokenRefresh(async () => {
            const searchResults = await this.twitterClient.v2.search({
                query,
                max_results: maxTweets,
                "tweet.fields": [
                    "created_at",
                    "conversation_id",
                    "in_reply_to_user_id",
                ],
                "user.fields": ["name", "username"],
                expansions: ["author_id", "referenced_tweets.id"],
            });

            const tweets = Array.from(searchResults).map((tweet) => ({
                id: tweet.id,
                text: tweet.text,
                conversationId: tweet.conversation_id || tweet.id,
                createdAt: tweet.created_at || new Date().toISOString(),
                userId: tweet.author_id || "",
                inReplyToStatusId: tweet.in_reply_to_user_id,
                permanentUrl: `https://twitter.com/i/web/status/${tweet.id}`,
                username: searchResults.includes?.users?.find(
                    (u) => u.id === tweet.author_id
                )?.username,
                name: searchResults.includes?.users?.find(
                    (u) => u.id === tweet.author_id
                )?.name,
                hashtags: [],
                mentions: [],
                photos: [],
                thread: [],
                urls: [],
                videos: [],
                timestamp: tweet.created_at
                    ? new Date(tweet.created_at).getTime() / 1000
                    : Date.now() / 1000,
            }));

            return { tweets };
        });
    }

    private async populateTimeline() {
        console.log("Populating timeline");
        const cacheFile = "timeline_cache.json";

        // Check if the cache file exists
        if (fs.existsSync(cacheFile)) {
            console.log("Cache file exists, reading cached results");
            // Read the cached search results from the file
            const cachedResults = JSON.parse(
                fs.readFileSync(cacheFile, "utf-8")
            );
            console.log(`Cached results: ${JSON.stringify(cachedResults)}`);

            // Get the existing memories from the database
            const existingMemories =
                await this.runtime.messageManager.getMemoriesByRoomIds({
                    agentId: this.runtime.agentId,
                    roomIds: cachedResults.map((tweet) =>
                        stringToUuid(
                            tweet.conversationId + "-" + this.runtime.agentId
                        )
                    ),
                });
            console.log(`Existing memories yes`);

            // Create a Set to store the IDs of existing memories
            const existingMemoryIds = new Set(
                existingMemories.map((memory) => memory.id.toString())
            );

            // Check if any of the cached tweets exist in the existing memories
            const someCachedTweetsExist = cachedResults.some((tweet) =>
                existingMemoryIds.has(tweet.id)
            );
            console.log(`Some cached tweets exist: ${someCachedTweetsExist}`);

            if (someCachedTweetsExist) {
                // Filter out the cached tweets that already exist in the database
                const tweetsToSave = cachedResults.filter(
                    (tweet) => !existingMemoryIds.has(tweet.id)
                );
                console.log(`Tweets to save: ${JSON.stringify(tweetsToSave)}`);

                // Save the missing tweets as memories
                for (const tweet of tweetsToSave) {
                    console.log(
                        `Processing tweet to save: ${JSON.stringify(tweet)}`
                    );
                    const roomId = stringToUuid(
                        tweet.conversationId ??
                            "default-room-" + this.runtime.agentId
                    );
                    const tweetuserId =
                        tweet.userId === this.twitterUserId
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId);

                    await this.runtime.ensureConnection(
                        tweetuserId,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    const content = {
                        text: tweet.text,
                        url: tweet.permanentUrl,
                        source: "twitter",
                        inReplyTo: tweet.inReplyToStatusId
                            ? stringToUuid(
                                  tweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    } as Content;

                    elizaLogger.log("Creating memory for tweet", tweet.id);

                    // Check if it already exists
                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        );
                    if (memory) {
                        elizaLogger.log(
                            "Memory already exists, skipping timeline population"
                        );
                        continue; // Use continue instead of break to process remaining tweets
                    }

                    await this.runtime.messageManager.createMemory({
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId: tweetuserId,
                        content: content,
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: embeddingZeroVector,
                        createdAt: tweet.timestamp * 1000,
                    });
                    console.log(`Saved tweet memory for ID: ${tweet.id}`);
                }

                elizaLogger.log(
                    `Populated ${tweetsToSave.length} missing tweets from the cache.`
                );
                return;
            } else {
                console.log("No cached tweets to save.");
            }
        } else {
            console.log("Cache file does not exist.");
        }

        // Get the most recent 20 mentions and interactions
        console.log("Fetching recent mentions and interactions");
        const mentionsAndInteractions = await this.fetchSearchTweets(
            `@${this.twitterUsername}`,
            20,
            SearchMode.Latest
        );

        // Combine the timeline tweets and mentions/interactions
        const allTweets = [...mentionsAndInteractions.tweets];
        console.log(`Fetched tweets: ${JSON.stringify(allTweets)}`);

        // Create a Set to store unique tweet IDs
        const tweetIdsToCheck = new Set<string>();

        // Add tweet IDs to the Set
        for (const tweet of allTweets) {
            tweetIdsToCheck.add(tweet.id);
        }

        // Convert the Set to an array of UUIDs
        const tweetUuids = Array.from(tweetIdsToCheck).map((id) =>
            stringToUuid(id + "-" + this.runtime.agentId)
        );

        // Check the existing memories in the database
        console.log("Checking existing memories in the database");
        const existingMemories =
            await this.runtime.messageManager.getMemoriesByRoomIds({
                agentId: this.runtime.agentId,
                roomIds: tweetUuids,
            });
        console.log(`Existing memories fetched`);

        // Create a Set to store the existing memory IDs
        const existingMemoryIds = new Set<UUID>(
            existingMemories.map((memory) => memory.roomId)
        );

        // Filter out the tweets that already exist in the database
        const tweetsToSave = allTweets.filter(
            (tweet) =>
                !existingMemoryIds.has(
                    stringToUuid(tweet.id + "-" + this.runtime.agentId)
                )
        );
        console.log(
            `Tweets to save after checking existing memories: ${JSON.stringify(tweetsToSave)}`
        );

        await this.runtime.ensureUserExists(
            this.runtime.agentId,
            this.twitterUsername,
            this.runtime.character.name,
            "twitter"
        );

        // Save the new tweets as memories
        for (const tweet of tweetsToSave) {
            console.log(`Saving new tweet: ${JSON.stringify(tweet)}`);
            const roomId = stringToUuid(
                tweet.conversationId ?? "default-room-" + this.runtime.agentId
            );
            const tweetuserId =
                tweet.userId === this.twitterUserId
                    ? this.runtime.agentId
                    : stringToUuid(tweet.userId);

            await this.runtime.ensureConnection(
                tweetuserId,
                roomId,
                tweet.username,
                tweet.name,
                "twitter"
            );

            const content = {
                text: tweet.text,
                url: tweet.permanentUrl,
                source: "twitter",
                inReplyTo: tweet.inReplyToStatusId
                    ? stringToUuid(tweet.inReplyToStatusId)
                    : undefined,
            } as Content;

            await this.runtime.messageManager.createMemory({
                id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                userId: tweetuserId,
                content: content,
                agentId: this.runtime.agentId,
                roomId,
                embedding: embeddingZeroVector,
                createdAt: tweet.timestamp * 1000,
            });
            console.log(`Saved tweet memory for ID: ${tweet.id}`);
        }

        // Cache the search results to the file
        fs.writeFileSync(cacheFile, JSON.stringify(allTweets));
        console.log("Cached all tweets to file.");
    }
    // async setCookiesFromArray(cookiesArray: any[]) {
    //     const cookieStrings = cookiesArray.map(
    //         (cookie) =>
    //             `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
    //                 cookie.secure ? "Secure" : ""
    //             }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
    //                 cookie.sameSite || "Lax"
    //             }`
    //     );

    // }

    async saveRequestMessage(message: Memory, state: State) {
        if (message.content.text) {
            const recentMessage = await this.runtime.messageManager.getMemories(
                {
                    roomId: message.roomId,
                    agentId: this.runtime.agentId,
                    count: 1,
                    unique: false,
                }
            );

            if (
                recentMessage.length > 0 &&
                recentMessage[0].content === message.content
            ) {
                console.log("Message already saved", recentMessage[0].id);
            } else {
                await this.runtime.messageManager.createMemory({
                    ...message,
                    embedding: embeddingZeroVector,
                });
            }

            await this.runtime.evaluate(message, {
                ...state,
                twitterClient: this.twitterClient,
            });
        }
    }

    async initializeProfile() {
        const username = this.twitterUsername;
        const description = this.twitterDescription;
        const name = this.twitterName;
        if (!username) {
            console.error("Twitter username not configured");
            return;
        }

        try {
            return {
                username,
                screenName: name || this.runtime.character.name,
                bio:
                    description ||
                    typeof this.runtime.character.bio === "string"
                        ? (this.runtime.character.bio as string)
                        : this.runtime.character.bio.length > 0
                          ? this.runtime.character.bio[0]
                          : "",
                nicknames:
                    this.runtime.character.twitterProfile?.nicknames || [],
            };
        } catch (error) {
            console.error("Error fetching Twitter profile:", error);
            return {
                username: this.runtime.character.name,
                screenName: username,
                bio:
                    typeof this.runtime.character.bio === "string"
                        ? (this.runtime.character.bio as string)
                        : this.runtime.character.bio.length > 0
                          ? this.runtime.character.bio[0]
                          : "",
                nicknames:
                    this.runtime.character.twitterProfile?.nicknames || [],
            };
        }
    }
}
