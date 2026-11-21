import {
    d as i,
    t as a
} from "./assets/index-BAqKxrEd.js";
import "./assets/vendor-KfUPlHYY.js";
async function m() {
    var r;
    const e = (r = chrome == null ? void 0 : chrome.storage) == null ? void 0 : r.local;
    return e ? new Promise(c => {
        e.get(["xtrack_migration_complete"], o => {
            c(!o.xtrack_migration_complete)
        })
    }) : !1
}
async function p() {
    var r;
    console.log("X-Track: Starting migration from chrome.storage to IndexedDB...");
    const e = (r = chrome == null ? void 0 : chrome.storage) == null ? void 0 : r.local;
    if (!e) {
        console.warn("X-Track: chrome.storage not available, skipping migration");
        return
    }
    try {
        const c = await new Promise(s => {
                e.get(["xtrack_history", "xtrack_bookmarks", "xtrack_likes"], s)
            }),
            o = c.xtrack_history || [],
            t = c.xtrack_bookmarks || [],
            u = c.xtrack_likes || [];
        if (console.log(`X-Track: Found ${o.length} history entries, ${t.length} bookmarks, ${u.length} likes`), o.length > 0) {
            const s = o.map(n => ({
                tweetId: n.tweetId,
                viewedAt: n.timestamp,
                durationSeconds: n.durationSeconds,
                type: n.type || "CLICK"
            }));
            await i.history.bulkAdd(s);
            const d = [],
                l = [],
                g = new Set,
                T = new Set;
            for (const n of o) n.tweetData && !g.has(n.tweetData.id) && (g.add(n.tweetData.id), d.push({
                id: n.tweetData.id,
                authorId: n.tweetData.handle,
                content: n.tweetData.content,
                createdAt: n.tweetData.timestamp,
                textTokens: a(n.tweetData.content),
                likes: n.tweetData.likes,
                retweets: n.tweetData.retweets,
                replies: n.tweetData.replies,
                views: n.tweetData.views,
                isReply: n.tweetData.isReply,
                media: n.tweetData.media
            }), n.tweetData.handle && !T.has(n.tweetData.handle) && (T.add(n.tweetData.handle), l.push({
                id: n.tweetData.handle,
                screenName: n.tweetData.handle,
                name: n.tweetData.author,
                avatarUrl: n.tweetData.avatarUrl
            })));
            d.length > 0 && await i.tweets.bulkAdd(d), l.length > 0 && await i.users.bulkAdd(l), console.log(`X-Track: Migrated ${s.length} history entries, ${d.length} tweets, ${l.length} users`)
        }
        if (t.length > 0) {
            const s = t.map(d => ({
                tweetId: d.id,
                addedAt: Date.now(),
                tags: [],
                synced: 0
            }));
            await i.bookmarks.bulkAdd(s), console.log(`X-Track: Migrated ${s.length} bookmarks`)
        }
        if (u.length > 0) {
            const s = u.map(d => ({
                tweetId: d.id,
                addedAt: Date.now()
            }));
            await i.likes.bulkAdd(s), console.log(`X-Track: Migrated ${s.length} likes`)
        }
        await new Promise(s => {
            e.set({
                xtrack_migration_complete: !0
            }, s)
        }), console.log("✅ X-Track: Migration completed successfully!")
    } catch (c) {
        throw console.error("X-Track: Migration error:", c), c
    }
}
console.log("X-Track: Background service worker loaded");
chrome.runtime.onInstalled.addListener(async () => {
    console.log("X-Track: Extension installed/updated");
    try {
        await m() ? (console.log("X-Track: Running migration from chrome.storage to IndexedDB..."), await p(), console.log("✅ X-Track: Migration completed")) : console.log("X-Track: No migration needed")
    } catch (e) {
        console.error("X-Track: Migration error:", e)
    }
});
chrome.runtime.onMessage.addListener((e, r, c) => {
    if (console.log("X-Track Background: Received message:", e.action), e.action === "SAVE_FOOTPRINT") return console.log("X-Track Background: Handling SAVE_FOOTPRINT"), y(e.data).then(() => {
        console.log("X-Track Background: SAVE_FOOTPRINT success"), c({
            success: !0
        })
    }).catch(o => {
        console.error("X-Track Background: SAVE_FOOTPRINT error:", o), c({
            success: !1,
            error: o.message
        })
    }), !0;
    if (e.action === "SAVE_BOOKMARK") return console.log("X-Track Background: Handling SAVE_BOOKMARK"), h(e.data).then(() => {
        console.log("X-Track Background: SAVE_BOOKMARK success"), c({
            success: !0
        })
    }).catch(o => {
        console.error("X-Track Background: SAVE_BOOKMARK error:", o), c({
            success: !1,
            error: o.message
        })
    }), !0;
    if (e.action === "SAVE_BATCH") {
        console.log(`X-Track Background: Handling SAVE_BATCH (${e.data.type})`, e.data.tweets.length);
        const o = w(e.data.type);
        return o ? (Promise.all(e.data.tweets.map(t => o({
            tweetData: t
        }))).then(() => {
            console.log(`X-Track Background: SAVE_BATCH (${e.data.type}) success`), c({
                success: !0,
                count: e.data.tweets.length
            })
        }).catch(t => {
            console.error(`X-Track Background: SAVE_BATCH (${e.data.type}) error:`, t), c({
                success: !1,
                error: t.message
            })
        }), !0) : (c({
            success: !1,
            error: "Unknown type"
        }), !0)
    }
    if (e.action === "UPDATE_TWEET_CONTENT") return console.log("X-Track Background: Handling UPDATE_TWEET_CONTENT for tweet", e.data.tweetId), f(e.data).then(() => {
        console.log("X-Track Background: UPDATE_TWEET_CONTENT success"), c({
            success: !0
        })
    }).catch(o => {
        console.error("X-Track Background: UPDATE_TWEET_CONTENT error:", o), c({
            success: !1,
            error: o.message
        })
    }), !0;
    console.log("X-Track Background: Unknown action:", e.action)
});

function w(e) {
    switch (e) {
        case "BOOKMARK":
            return h;
        case "LIKE":
            return X;
        case "MYTWEET":
            return A;
        case "HISTORY":
            return v;
        default:
            return null
    }
}
async function y({
    tweetData: e,
    durationMs: r
}) {
    console.log("X-Track Background: Saving footprint for tweet", e == null ? void 0 : e.id);
    try {
        if (!e || !e.id) throw new Error("Invalid tweet data for footprint");
        if (!e.handle || e.handle === "unknown") {
            console.log("X-Track: Skipping footprint save - unknown user handle");
            return
        }
        await i.tweets.put({
            id: e.id,
            authorId: e.handle,
            content: e.content,
            createdAt: e.timestamp,
            textTokens: a(e.content),
            likes: e.likes,
            retweets: e.retweets,
            replies: e.replies,
            views: e.views,
            isReply: e.isReply,
            tweetType: e.tweetType || "ORIGINAL",
            retweetedFrom: e.retweetedFrom || null,
            quotedTweet: e.quotedTweet || null,
            media: e.media
        }), await i.users.put({
            id: e.handle,
            screenName: e.handle,
            name: e.author,
            avatarUrl: e.avatarUrl
        }), await i.history.where("tweetId").equals(e.id).and(o => Date.now() - o.viewedAt < 6e4).first() ? console.log("X-Track: Duplicate footprint skipped") : (await i.history.add({
            tweetId: e.id,
            viewedAt: Date.now(),
            durationSeconds: Math.round(r / 1e3),
            type: r > 1e4 ? "DWELL" : "CLICK"
        }), console.log("✅ X-Track: Footprint saved to IndexedDB"))
    } catch (c) {
        throw console.error("X-Track: Error saving footprint:", c), c
    }
}
async function f({
    tweetId: e,
    content: r,
    tweetType: c
}) {
    console.log("X-Track Background: Updating tweet content for", e);
    try {
        const o = await i.tweets.get(e);
        o ? (await i.tweets.update(e, {
            content: r,
            tweetType: c || o.tweetType,
            textTokens: a(r)
        }), console.log("✅ X-Track: Updated tweet content with article")) : (console.log("X-Track: Tweet not found to update, saving as new"), await i.tweets.put({
            id: e,
            authorId: "unknown",
            content: r,
            createdAt: new Date().toISOString(),
            textTokens: a(r),
            likes: 0,
            retweets: 0,
            replies: 0,
            views: 0,
            isReply: !1,
            tweetType: c || "ARTICLE",
            media: []
        }))
    } catch (o) {
        throw console.error("X-Track: Error updating tweet content:", o), o
    }
}
async function h({
    tweetData: e
}) {
    console.log("X-Track Background: Saving bookmark for tweet", e == null ? void 0 : e.id);
    try {
        if (!(e != null && e.handle) || e.handle === "unknown") {
            console.log("X-Track: Skipping bookmark save - unknown user handle");
            return
        }
        await k(e), await i.bookmarks.put({
            tweetId: e.id,
            addedAt: Date.now(),
            tags: [],
            synced: 0
        }), console.log("✅ X-Track: Bookmark saved to IndexedDB")
    } catch (r) {
        throw console.error("X-Track: Error saving bookmark:", r), r
    }
}
async function X({
    tweetData: e
}) {
    console.log("X-Track Background: Saving like for tweet", e == null ? void 0 : e.id);
    try {
        if (!(e != null && e.handle) || e.handle === "unknown") {
            console.log("X-Track: Skipping like save - unknown user handle");
            return
        }
        await k(e), await i.likes.put({
            tweetId: e.id,
            addedAt: Date.now(),
            synced: 0
        }), console.log("✅ X-Track: Like saved to IndexedDB")
    } catch (r) {
        throw console.error("X-Track: Error saving like:", r), r
    }
}
async function v({
    tweetData: e
}) {
    console.log("X-Track Background: Saving history for tweet", e == null ? void 0 : e.id);
    try {
        if (!(e != null && e.handle) || e.handle === "unknown") {
            console.log("X-Track: Skipping history save - unknown user handle");
            return
        }
        await k(e), await i.history.where("tweetId").equals(e.id).first() ? console.log("X-Track: Duplicate history entry skipped") : (await i.history.add({
            tweetId: e.id,
            viewedAt: Date.now(),
            durationSeconds: 0,
            type: "SCRAPE"
        }), console.log("✅ X-Track: History entry saved to IndexedDB"))
    } catch (r) {
        throw console.error("X-Track: Error saving history:", r), r
    }
}
async function A({
    tweetData: e
}) {
    console.log("X-Track Background: Saving myTweet for tweet", e == null ? void 0 : e.id);
    try {
        if (!(e != null && e.handle) || e.handle === "unknown") {
            console.log("X-Track: Skipping myTweet save - unknown user handle");
            return
        }
        await k(e), await i.myTweets.put({
            id: e.id,
            createdAt: Date.now(),
            synced: 0
        }), console.log("✅ X-Track: MyTweet saved to IndexedDB")
    } catch (r) {
        throw console.error("X-Track: Error saving myTweet:", r), r
    }
}
async function k(e) {
    if (!e || !e.id) throw new Error("Invalid tweet data");
    try {
        await i.tweets.put({
            id: e.id,
            authorId: e.handle,
            content: e.content,
            createdAt: e.timestamp,
            textTokens: a(e.content),
            likes: e.likes,
            retweets: e.retweets,
            replies: e.replies,
            views: e.views,
            tweetType: e.tweetType || "ORIGINAL",
            retweetedFrom: e.retweetedFrom || null,
            quotedTweet: e.quotedTweet || null,
            media: e.media
        }), e.handle && e.handle !== "unknown" && await i.users.put({
            id: e.handle,
            screenName: e.handle,
            name: e.author || e.handle,
            avatarUrl: e.avatarUrl || ""
        }), e.retweetedFrom && e.retweetedFrom.handle && e.retweetedFrom.handle !== "unknown" && await i.users.put({
            id: e.retweetedFrom.handle,
            screenName: e.retweetedFrom.handle,
            name: e.retweetedFrom.author || e.retweetedFrom.handle,
            avatarUrl: e.retweetedFrom.avatarUrl || ""
        }), e.quotedTweet && e.quotedTweet.handle && e.quotedTweet.handle !== "unknown" && await i.users.put({
            id: e.quotedTweet.handle,
            screenName: e.quotedTweet.handle,
            name: e.quotedTweet.author || e.quotedTweet.handle,
            avatarUrl: e.quotedTweet.avatarUrl || ""
        })
    } catch (r) {
        throw console.error("X-Track Background: Error in saveTweetAndUser:", r), r
    }
}