import { Tweet, ClientBase } from "./base.ts";  // Using our own tweet
import fs from "fs";
import { composeContext } from "@ai16z/eliza";
import { generateText } from "@ai16z/eliza";
import { embeddingZeroVector } from "@ai16z/eliza";
import { IAgentRuntime, ModelClass } from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";

const twitterPostTemplate = `{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

{{providers}}

{{recentPosts}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{twitterUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.`;

const MAX_TWEET_LENGTH = 280;

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
function truncateToCompleteSentence(text: string): string {
    if (text.length <= MAX_TWEET_LENGTH) {
        return text;
    }

    // Attempt to truncate at the last period within the limit
    const truncatedAtPeriod = text.slice(
        0,
        text.lastIndexOf(".", MAX_TWEET_LENGTH) + 1
    );
    if (truncatedAtPeriod.trim().length > 0) {
        return truncatedAtPeriod.trim();
    }

    // If no period is found, truncate to the nearest whitespace
    const truncatedAtSpace = text.slice(
        0,
        text.lastIndexOf(" ", MAX_TWEET_LENGTH)
    );
    if (truncatedAtSpace.trim().length > 0) {
        return truncatedAtSpace.trim() + "...";
    }

    // Fallback: Hard truncate and add ellipsis
    return text.slice(0, MAX_TWEET_LENGTH - 3).trim() + "...";
}

export class TwitterPostClient extends ClientBase {
    onReady(postImmediately: boolean = true) {
        const generateNewTweetLoop = () => {
            const minMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
            const maxMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            setTimeout(() => {
                this.generateNewTweet();
                generateNewTweetLoop(); // Set up next iteration
            }, delay);

            console.log(`Next tweet scheduled in ${randomMinutes} minutes`);
        };

        if (postImmediately) {
            this.generateNewTweet();
        }
        generateNewTweetLoop();
    }

    constructor(runtime: IAgentRuntime) {
        super({
            runtime,
        });
    }

    private async generateNewTweet() {
        await this.ensureReady();
        console.log("Generating new tweet");
        try {
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.twitterUsername,
                this.runtime.character.name,
                "twitter"
            );

            let homeTimeline = [];
            
            if (!fs.existsSync("tweetcache")) fs.mkdirSync("tweetcache");
            if (fs.existsSync("tweetcache/home_timeline.json")) {
                homeTimeline = JSON.parse(
                    fs.readFileSync("tweetcache/home_timeline.json", "utf-8")
                );
                console.log("POST_NEW_TWEET -cached home timeline present");
            } else {
                console.log("POST_NEW_TWEET -fetching home timeline");
                homeTimeline = await this.fetchHomeTimeline(50);
                fs.writeFileSync(
                    "tweetcache/home_timeline.json",
                    JSON.stringify(homeTimeline, null, 2)
                );
            }

            const formattedHomeTimeline =
                `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .map((tweet) => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    })
                    .join("\n");
            console.log("POST_NEW_TWEET -composing state");

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid("twitter_generate_room"),
                    agentId: this.runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    twitterUserName:
                        this.twitterUsername,
                    timeline: formattedHomeTimeline,
                }
            );
            console.log("POST_NEW_TWEET -composing context");

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });
            console.log("POST_NEW_TWEET -generating text");
            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // Replace \n with proper line breaks and trim excess spaces
            const formattedTweet = newTweetContent
                .replaceAll(/\\n/g, "\n")
                .trim();

            // Use the helper function to truncate to complete sentence
            const content = truncateToCompleteSentence(formattedTweet);

            console.log("POST_NEW_TWEET -sending tweet");
            try {
                const tweetResponse = await this.requestQueue.add(
                    async () => await this.twitterClient.v2.tweet(content)
                );
                if (!tweetResponse.data) {
                    throw new Error("Failed to create tweet");
                }

                console.log("POST_NEW_TWEET -tweet created with tweet id", tweetResponse.data.id);

                console.log("POST_NEW_TWEET -getting tweet details");
                const tweetDetails = await this.twitterClient.v2.singleTweet( tweetResponse.data.id,
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

                console.log("POST_NEW_TWEET -mapping tweet");
                const tweet: Tweet = {
                    id: tweetDetails.data.id,
                    text: content,
                    conversationId: tweetDetails.data.conversation_id || tweetResponse.data.id,
                    createdAt: tweetDetails.data.created_at || new Date().toISOString(),
                    userId: this.twitterUserId,
                    permanentUrl: `https://twitter.com/${this.twitterUsername}/status/${tweetDetails.data.id}`,
                    username: tweetDetails.includes?.users?.find(user => user.id === tweetDetails.data.author_id).username,
                    name: tweetDetails.includes?.users?.find(user => user.id === tweetDetails.data.author_id).name,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                    timestamp: Date.now()
                };

                const postId = tweet.id;
                const conversationId =
                    tweet.conversationId + "-" + this.runtime.agentId;
                const roomId = stringToUuid(conversationId);

                console.log("POST_NEW_TWEET -ensuring room exists");
                await this.runtime.ensureRoomExists(roomId);
                console.log("POST_NEW_TWEET -ensuring participant in room");
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                console.log("POST_NEW_TWEET -caching tweet");
                await this.cacheTweet(tweet);

                console.log("POST_NEW_TWEET -creating memory");
                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(postId + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: embeddingZeroVector,
                    createdAt: tweet.timestamp * 1000,
                }); 
                console.log("POST_NEW_TWEET -done");
            } catch (error) {
                console.error("Error sending tweet:", error);
            }
        } catch (error) {
            console.error("Error generating new tweet:", error);
        }
    }
}
