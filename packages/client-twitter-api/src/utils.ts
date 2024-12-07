import { Tweet, ClientBase } from "./base.ts";  // Changed import to use our own Tweet type

import { embeddingZeroVector } from "@ai16z/eliza";
import { Content, Memory, UUID } from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { elizaLogger } from "@ai16z/eliza";

const MAX_TWEET_LENGTH = 280; // Updated to Twitter's current character limit

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

export const isValidTweet = (tweet: Tweet): boolean => {
    // Filter out tweets with too many hashtags, @s, or $ signs, probably spam or garbage
    const hashtagCount = (tweet.text?.match(/#/g) || []).length;
    const atCount = (tweet.text?.match(/@/g) || []).length;
    const dollarSignCount = (tweet.text?.match(/\$/g) || []).length;
    const totalCount = hashtagCount + atCount + dollarSignCount;

    return (
        hashtagCount <= 1 &&
        atCount <= 2 &&
        dollarSignCount <= 1 &&
        totalCount <= 3
    );
};

export async function buildConversationThread(
    tweet: Tweet,
    client: ClientBase
): Promise<void> {
    const thread: Tweet[] = [];
    const visited: Set<string> = new Set();

    async function processThread(currentTweet: Tweet) {
        if (!currentTweet) {
            elizaLogger.log("No current tweet found");
            return;
        }
        // Check if the current tweet has already been saved
        const memory = await client.runtime.messageManager.getMemoryById(
            stringToUuid(currentTweet.id + "-" + client.runtime.agentId)
        );
        if (!memory) {
            elizaLogger.log("Creating memory for tweet", currentTweet.id);
            const roomId = stringToUuid(
                currentTweet.conversationId + "-" + client.runtime.agentId
            );
            const userId =
                currentTweet.userId === client.twitterUserId
                    ? client.runtime.agentId
                    : stringToUuid(currentTweet.userId);

            await client.runtime.ensureConnection(
                userId,
                roomId,
                currentTweet.username,
                currentTweet.name,
                "twitter"
            );

            await client.runtime.messageManager.createMemory({
                id: stringToUuid(
                    currentTweet.id + "-" + client.runtime.agentId
                ),
                agentId: client.runtime.agentId,
                userId: userId,
                content: {
                    text: currentTweet.text,
                    source: "twitter",
                    url: currentTweet.permanentUrl,
                    inReplyTo: currentTweet.inReplyToStatusId
                        ? stringToUuid(
                              currentTweet.inReplyToStatusId +
                                  "-" +
                                  client.runtime.agentId
                          )
                        : undefined,
                },
                createdAt: currentTweet.timestamp * 1000,
                roomId,
                embedding: embeddingZeroVector,
            });
        }
        if (visited.has(currentTweet.id)) {
            return;
        }
        visited.add(currentTweet.id);

        thread.unshift(currentTweet);

        if (currentTweet.inReplyToStatusId) {
            try {
                const result = await client.twitterClient.v2.singleTweet(
                    currentTweet.inReplyToStatusId,
                    {
                        "tweet.fields": [
                            "created_at",
                            "conversation_id",
                            "in_reply_to_user_id",
                            "entities",
                            "attachments",
                            "referenced_tweets",
                            "text"
                        ],
                        "user.fields": ["name", "username"],
                        "expansions": [
                            "author_id",
                            "attachments.media_keys",
                            "referenced_tweets.id",
                            "entities.mentions.username"
                        ],
                        "media.fields": [
                            "url",
                            "type",
                            "preview_image_url",
                            "alt_text"
                        ]
                    }
                );

                if (result.data) {
                    const author = result.includes?.users?.find(u => u.id === result.data.author_id);
                    const parentTweet: Tweet = {
                        id: result.data.id,
                        text: result.data.text,
                        conversationId: result.data.conversation_id || result.data.id,
                        createdAt: result.data.created_at || new Date().toISOString(),
                        userId: result.data.author_id || '',
                        inReplyToStatusId: result.data.in_reply_to_user_id || undefined,
                        permanentUrl: `https://twitter.com/${author?.username}/status/${result.data.id}`,
                        username: author?.username,
                        name: author?.name,
                        hashtags: [],
                        mentions: [],
                        photos: [],
                        thread: [],
                        urls: [],
                        videos: [],
                        timestamp: result.data.created_at 
                            ? new Date(result.data.created_at).getTime() / 1000 
                            : Date.now() / 1000
                    };
                    await processThread(parentTweet);
                }
            } catch (error) {
                console.error("Error fetching conversation:", error);
            }
        }
    }

    await processThread(tweet);
}

export async function sendTweet(
    client: ClientBase,
    content: Content,
    roomId: UUID,
    twitterUsername: string,
    inReplyTo: string
): Promise<Memory[]> {
    const tweetChunks = splitTweetContent(content.text);
    const sentTweets: Tweet[] = [];
    let previousTweetId = inReplyTo;

    for (const chunk of tweetChunks) {
        const tweetResponse = await client.requestQueue.add(async () => {
            return await client.twitterClient.v2.reply(
                chunk.replaceAll(/\\n/g, "\n").trim(),
                previousTweetId
            );
        });
        
        const tweetResult = await tweetResponse;
        if (!tweetResult) {
            throw new Error("Failed to create tweet");
        }

                //const getTweetResult = await client.twitterClient.v2.get(`tweets/${tweetResult.data.id}`);
        const getTweetResult = await client.twitterClient.v2.singleTweet(tweetResult.data.id,
            {
                "tweet.fields": [
                    "created_at",
                    "conversation_id",
                    "in_reply_to_user_id",
                    "entities",
                    "attachments",
                    "referenced_tweets",
                    "text"
                ],
                "user.fields": ["name", "username"],
                "expansions": [
                    "author_id",
                    "attachments.media_keys",
                    "referenced_tweets.id",
                    "entities.mentions.username"
                ],
                "media.fields": [
                    "url",
                    "type",
                    "preview_image_url",
                    "alt_text"
                ]
            }
        );

        if (!getTweetResult) {
            throw new Error("Failed to get tweet");
        }
        

        console.log("sent tweet result:\n", getTweetResult.data.id);

        const finalTweet = {
            id: getTweetResult.data.id,
            text: getTweetResult.data.text,
            conversationId: getTweetResult.data.conversation_id,
            createdAt: getTweetResult.data.created_at,
            userId: getTweetResult.data.author_id,
            inReplyToStatusId: getTweetResult.data.in_reply_to_user_id,
            permanentUrl: `https://twitter.com/${getTweetResult.data.author_id}/status/${getTweetResult.data.id}`,
            hashtags: getTweetResult.data.entities?.hashtags || [],
            mentions: getTweetResult.data.entities?.mentions || [],
            photos: [],
            thread: [],
            urls: getTweetResult.data.entities?.urls.map((url) => url.url) || [],
            videos: [],
            timestamp: getTweetResult.data.created_at ? new Date(getTweetResult.data.created_at).getTime() / 1000 : Date.now() / 1000
        } as Tweet;

        sentTweets.push(finalTweet);

        // Wait a bit between tweets to avoid rate limiting issues
        await wait(1000, 2000);
    }

    const memories: Memory[] = sentTweets.map((tweet) => ({
        id: stringToUuid(tweet.id + "-" + client.runtime.agentId),
        agentId: client.runtime.agentId,
        userId: client.runtime.agentId,
        content: {
            text: tweet.text,
            source: "twitter",
            url: tweet.permanentUrl,
            inReplyTo: tweet.inReplyToStatusId
                ? stringToUuid(
                      tweet.inReplyToStatusId + "-" + client.runtime.agentId
                  )
                : undefined,
        },
        roomId,
        embedding: embeddingZeroVector,
        createdAt: tweet.timestamp * 1000,
    }));

    return memories;
}

function splitTweetContent(content: string): string[] {
    const maxLength = MAX_TWEET_LENGTH;
    const paragraphs = content.split("\n\n").map((p) => p.trim());
    const tweets: string[] = [];
    let currentTweet = "";

    for (const paragraph of paragraphs) {
        if (!paragraph) continue;

        if ((currentTweet + "\n\n" + paragraph).trim().length <= maxLength) {
            if (currentTweet) {
                currentTweet += "\n\n" + paragraph;
            } else {
                currentTweet = paragraph;
            }
        } else {
            if (currentTweet) {
                tweets.push(currentTweet.trim());
            }
            if (paragraph.length <= maxLength) {
                currentTweet = paragraph;
            } else {
                // Split long paragraph into smaller chunks
                const chunks = splitParagraph(paragraph, maxLength);
                tweets.push(...chunks.slice(0, -1));
                currentTweet = chunks[chunks.length - 1];
            }
        }
    }

    if (currentTweet) {
        tweets.push(currentTweet.trim());
    }

    return tweets;
}

function splitParagraph(paragraph: string, maxLength: number): string[] {
    const sentences = paragraph.match(/[^\.!\?]+[\.!\?]+|[^\.!\?]+$/g) || [
        paragraph,
    ];
    const chunks: string[] = [];
    let currentChunk = "";

    for (const sentence of sentences) {
        if ((currentChunk + " " + sentence).trim().length <= maxLength) {
            if (currentChunk) {
                currentChunk += " " + sentence;
            } else {
                currentChunk = sentence;
            }
        } else {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            if (sentence.length <= maxLength) {
                currentChunk = sentence;
            } else {
                // Split long sentence into smaller pieces
                const words = sentence.split(" ");
                currentChunk = "";
                for (const word of words) {
                    if (
                        (currentChunk + " " + word).trim().length <= maxLength
                    ) {
                        if (currentChunk) {
                            currentChunk += " " + word;
                        } else {
                            currentChunk = word;
                        }
                    } else {
                        if (currentChunk) {
                            chunks.push(currentChunk.trim());
                        }
                        currentChunk = word;
                    }
                }
            }
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}
