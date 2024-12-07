import { ClientBase, SearchMode, Tweet } from "./base.ts";
import fs from "fs";
import { composeContext } from "@ai16z/eliza";
import { generateMessageResponse, generateText } from "@ai16z/eliza";
import { messageCompletionFooter } from "@ai16z/eliza";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IImageDescriptionService,
    ModelClass,
    ServiceType,
    State,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";

const twitterSearchTemplate =
    `{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{postDirections}}

{{recentPosts}}

# Task: Respond to the following post in the style and perspective of {{agentName}} (aka @{{twitterUserName}}). Write a {{adjective}} response for {{agentName}} to say directly in response to the post. don't generalize.
{{currentPost}}

IMPORTANT: Your response CANNOT be longer than 20 words.
Aim for 1-2 short sentences maximum. Be concise and direct.

Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.

` + messageCompletionFooter;

export class TwitterSearchClient extends ClientBase {
    private respondedTweets: Set<string> = new Set();

    constructor(runtime: IAgentRuntime) {
        // Initialize the client and pass an optional callback to be called when the client is ready
        super({
            runtime,
        });
    }

    async onReady() {
        this.engageWithSearchTermsLoop();
    }

    private engageWithSearchTermsLoop() {
        this.engageWithSearchTerms();
        setTimeout(
            () => this.engageWithSearchTermsLoop(),
            (Math.floor(Math.random() * (120 - 60 + 1)) + 60) * 60 * 1000
        );
    }

    private formatHomeTimeline(timeline: Tweet[]): string {
        return `# ${this.runtime.character.name}'s Home Timeline\n\n` +
            timeline.map((tweet) => 
                `ID: ${tweet.id}\nFrom: ${tweet.username} (@${tweet.username})${
                    tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""
                }\nText: ${tweet.text}\n---\n`
            ).join("\n");
    }

    private selectRandomTweets(tweets: Tweet[], count: number): Tweet[] {
        
        return tweets
            .sort(() => Math.random() - 0.5)
            .slice(0, count)
            .filter(tweet => 
                tweet.username !== this.twitterUsername &&
                !tweet.thread.some(t => t.tweet.username === this.twitterUsername)
            );
    }

    private buildTweetSelectionPrompt(tweets: Tweet[], homeTimeline: Tweet[], searchTerm: string): string {
        
        return `
        Here are some tweets related to the search term "${searchTerm}":
        
        ${[...tweets, ...homeTimeline]
            .filter((tweet) => {
                // ignore tweets where any of the thread tweets contain a tweet by the bot
                const thread = tweet.thread;
                const botTweet = thread.find(
                    (t) => t.tweet.username === this.twitterUsername
                );
                return !botTweet;
            })
            .map((tweet) => `
            ID: ${tweet.id}${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}
            From: ${tweet.name} (@${tweet.username})
            Text: ${tweet.text}
          `
              )
              .join("\n")}
          
          Which tweet is the most interesting and relevant for Ruby to reply to? Please provide only the ID of the tweet in your response.
          Notes:
            - Respond to English tweets only
            - Respond to tweets that don't have a lot of hashtags, links, URLs or images
            - Respond to tweets that are not retweets
            - Respond to tweets where there is an easy exchange of ideas to have with the user
            - ONLY respond with the ID of the tweet`;
    }

    private async selectInterestingTweet(tweets: Tweet[], homeTimeline: Tweet[], searchTerm: string): Promise<Tweet | null> {
    
        const prompt = this.buildTweetSelectionPrompt(tweets, homeTimeline, searchTerm);
        // const datestr = new Date().toUTCString().replace(/:/g, "-");
        
        // log_to_file(`${this.runtime.character.name}_search_${datestr}`, prompt);

        const tweetIdResponse = await generateText({
            runtime: this.runtime,
            context: prompt,
            modelClass: ModelClass.SMALL,
        });

        const tweetId = tweetIdResponse.trim();
        const selectedTweet = tweets.find(tweet => 
            tweet.id.toString().includes(tweetId) || tweetId.includes(tweet.id.toString())
        );

        if (!selectedTweet) {
            console.log("No matching tweet found for the selected ID:", tweetId);
            return null;
        }

        return selectedTweet;
    }


    private async engageWithSearchTerms() {
        await this.ensureReady();
        console.log("Engaging with search terms");
        try {
            const searchTerm = [...this.runtime.character.topics][
                Math.floor(Math.random() * this.runtime.character.topics.length)
            ];

            if (!fs.existsSync("tweetcache")) {
                fs.mkdirSync("tweetcache");
            }
            console.log("Fetching search tweets");
            // TODO: we wait 5 seconds here to avoid getting rate limited on startup, but we should queue
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const recentTweets = await this.fetchSearchTweets(
                searchTerm,
                20,
                SearchMode.Top
            );
            console.log("Search tweets fetched");

            const homeTimeline = await this.fetchHomeTimeline(50);
            fs.writeFileSync(
                "tweetcache/home_timeline.json",
                JSON.stringify(homeTimeline, null, 2)
            );
            // Format timeline for display
            const formattedHomeTimeline = this.formatHomeTimeline(homeTimeline);

            // randomly slice .tweets down to 20
           // Randomly select tweets to process
           const slicedTweets = this.selectRandomTweets(recentTweets.tweets, 20);

            if (slicedTweets.length === 0) {
                console.log(
                    "No valid tweets found for the search term",
                    searchTerm
                );
                return;
            }

            // Select most interesting tweet
            const selectedTweet = await this.selectInterestingTweet(slicedTweets, homeTimeline, searchTerm);

            if (!selectedTweet) {
                console.log("No matching tweet found for the selected ID");
                return console.log("Selected tweet ID:", selectedTweet.id);
            }

            console.log("Selected tweet to reply to:", selectedTweet?.text);

            if (
                selectedTweet.username ===
                this.twitterUsername
            ) {
                console.log("Skipping tweet from bot itself");
                return;
            }

            const conversationId = selectedTweet.conversationId;
            const roomId = stringToUuid(
                conversationId + "-" + this.runtime.agentId
            );

            const userIdUUID = stringToUuid(selectedTweet.userId as string);

            await this.runtime.ensureConnection(
                userIdUUID,
                roomId,
                selectedTweet.username,
                selectedTweet.name,
                "twitter"
            );

            // crawl additional conversation tweets, if there are any
            await buildConversationThread(selectedTweet, this);

            const message = {
                id: stringToUuid(selectedTweet.id + "-" + this.runtime.agentId),
                agentId: this.runtime.agentId,
                content: {
                    text: selectedTweet.text,
                    url: selectedTweet.permanentUrl,
                    inReplyTo: selectedTweet.inReplyToStatusId
                        ? stringToUuid(
                              selectedTweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                // Timestamps are in seconds, but we need them in milliseconds
                createdAt: selectedTweet.timestamp * 1000,
            };

            if (!message.content.text) {
                return { text: "", action: "IGNORE" };
            }

            // Fetch replies and retweets
            const replies = selectedTweet.thread;
            const replyContext = replies
                .filter(
                    (reply) =>
                        reply.tweet.username !==
                        this.twitterUsername
                )
                .map((reply) => `@${reply.tweet.username}: ${reply.tweet.text}`)
                .join("\n");

            let tweetBackground = "";
            const retweetItem = selectedTweet.thread.find(item => item.type === 'retweet');
            if (retweetItem) {
                const originalTweet = await this.requestQueue.add(() =>
                    this.twitterClient.v2.singleTweet(selectedTweet.id, 
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
                    )
                );
                tweetBackground = `Retweeting @${originalTweet.includes?.users?.find(user => user.id === originalTweet.data.author_id).username}: ${originalTweet.data.text}`;
            }

            // Generate image descriptions using GPT-4 vision API
            const imageDescriptions = [];
            for (const photo of selectedTweet.photos) {
                const description = await this.runtime
                    .getService(ServiceType.IMAGE_DESCRIPTION)
                    .getInstance<IImageDescriptionService>()
                    .describeImage(photo.url);
                imageDescriptions.push(description);
            }

            let state = await this.runtime.composeState(message, {
                twitterClient: this.twitterClient,
                twitterUserName: this.twitterUsername,
                timeline: formattedHomeTimeline,
                tweetContext: `${tweetBackground}
  
  Original Post:
  By @${selectedTweet.username}
  ${selectedTweet.text}${replyContext.length > 0 && `\nReplies to original post:\n${replyContext}`}
  ${`Original post text: ${selectedTweet.text}`}
  ${selectedTweet.urls.length > 0 ? `URLs: ${selectedTweet.urls.join(", ")}\n` : ""}${imageDescriptions.length > 0 ? `\nImages in Post (Described): ${imageDescriptions.join(", ")}\n` : ""}
  `,
            });

            await this.saveRequestMessage(message, state as State);

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterSearchTemplate ||
                    twitterSearchTemplate,
            });

            const responseContent = await generateMessageResponse({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            responseContent.inReplyTo = message.id;

            const response = responseContent;

            if (!response.text) {
                console.log("Returning: No response text found");
                return;
            }

            console.log(
                `Bot would respond to tweet ${selectedTweet.id} with: ${response.text}`
            );
            try {
                const callback: HandlerCallback = async (response: Content) => {
                    const memories = await sendTweet(
                        this,
                        response,
                        message.roomId,
                        this.twitterUsername,
                        selectedTweet.id
                    );
                    return memories;
                };

                const responseMessages = await callback(responseContent);

                state = await this.runtime.updateRecentMessageState(state);

                for (const responseMessage of responseMessages) {
                    await this.runtime.messageManager.createMemory(
                        responseMessage,
                        false
                    );
                }

                state = await this.runtime.updateRecentMessageState(state);

                await this.runtime.evaluate(message, state);

                await this.runtime.processActions(
                    message,
                    responseMessages,
                    state,
                    callback
                );

                this.respondedTweets.add(selectedTweet.id);
                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}\nAgent's Output:\n${response.text}`;
                const debugFileName = `tweetcache/tweet_generation_${selectedTweet.id}.txt`;

                fs.writeFileSync(debugFileName, responseInfo);
                await wait();
            } catch (error) {
                console.error(`Error sending response post: ${error}`);
            }
        } catch (error) {
            console.error("Error engaging with search terms:", error);
        }
    }
}
