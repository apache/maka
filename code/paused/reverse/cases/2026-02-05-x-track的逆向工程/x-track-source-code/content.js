// This script runs on x.com to track user behavior

console.log("X-Track: Content script loaded");

let viewingTimers = {};
const DWELL_THRESHOLD = 1000; // 1 second to count as a "view" (lowered for better sensitivity)
const OBSERVED_ATTR = 'data-xtrack-observed';
let periodicObserverInterval = null;
let isInitialized = false;

// --- Network Interception & Caching ---
const tweetCache = new Map();

// Inject interception script
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
  console.log('X-Track: Injected network interceptor');
}

// Listen for intercepted data
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'XTRACK_INJECT') return;

  if (event.data.type === 'XTRACK_INTERCEPT_DATA') {
    console.log('X-Track: Received intercepted data from', event.data.url);
    processInterceptedData(event.data.data, event.data.url);
  }
});

// Get current logged-in user's screen_name from DOM
function getCurrentUserScreenName() {
  // Method 1: Check SideNav Account Switcher
  const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  if (accountSwitcher) {
    const allSpans = accountSwitcher.querySelectorAll('span');
    for (const span of allSpans) {
      const text = span.textContent || '';
      if (text.startsWith('@')) {
        return text.replace('@', '').toLowerCase();
      }
    }
  }
  // Method 2: Check profile link
  const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  if (profileLink) {
    const href = profileLink.getAttribute('href');
    if (href) {
      return href.replace('/', '').toLowerCase();
    }
  }
  return null;
}

// Cache for profile page user info to avoid repeated DOM queries
let cachedProfileUserInfo = null;
let cachedProfilePath = null;

// Get user info from the profile page header (for profile pages)
function getProfilePageUserInfo() {
  const currentPath = window.location.pathname;

  // Return cached if path hasn't changed
  if (cachedProfilePath === currentPath && cachedProfileUserInfo) {
    return cachedProfileUserInfo;
  }

  // Only works on profile pages
  const pathMatch = currentPath.match(/^\/([^\/]+)/);
  if (!pathMatch || ['i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings'].includes(pathMatch[1])) {
    return null;
  }

  const handle = pathMatch[1];
  let name = handle;
  let avatarUrl = '';

  // Try to get name from profile header
  // Method 1: Profile header title
  const profileTitle = document.querySelector('[data-testid="UserName"] span, [data-testid="primaryColumn"] [dir="ltr"] span');
  if (profileTitle) {
    const titleText = profileTitle.textContent || '';
    if (titleText && !titleText.startsWith('@')) {
      name = titleText;
    }
  }

  // Method 2: Check the header bar
  const headerBar = document.querySelector('h2[role="heading"]');
  if (headerBar && !name) {
    const headerText = headerBar.textContent || '';
    if (headerText && !headerText.startsWith('@')) {
      name = headerText;
    }
  }

  // Try to get avatar from profile header
  // Method 1: Profile avatar in header
  const profileAvatar = document.querySelector('[data-testid="UserAvatar-Container-' + handle + '"] img, a[href="/' + handle + '/photo"] img');
  if (profileAvatar && profileAvatar.src) {
    avatarUrl = profileAvatar.src;
  }

  // Method 2: Any avatar that contains profile_images
  if (!avatarUrl) {
    const avatars = document.querySelectorAll('img[src*="profile_images"]');
    for (const avatar of avatars) {
      // Skip small avatars (likely in tweets), look for larger ones
      if (avatar.width >= 48 || avatar.height >= 48) {
        avatarUrl = avatar.src;
        break;
      }
    }
  }

  // Method 3: First profile image in primary column
  if (!avatarUrl) {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    if (primaryColumn) {
      const img = primaryColumn.querySelector('img[src*="profile_images"]');
      if (img) {
        avatarUrl = img.src;
      }
    }
  }

  const userInfo = { handle, name, avatarUrl };

  // Cache the result
  cachedProfilePath = currentPath;
  cachedProfileUserInfo = userInfo;

  console.log('X-Track: Extracted profile page user info:', userInfo);
  return userInfo;
}

// Extract user screen_name from UserTweets URL
function getUserFromTweetsUrl(url) {
  if (!url) return null;
  // URL format: https://x.com/i/api/graphql/.../UserTweets?variables={"userId":"...",...}
  // Or page URL: https://x.com/username or https://x.com/username/with_replies
  const pageMatch = window.location.pathname.match(/^\/([^\/]+)/);
  if (pageMatch && pageMatch[1] && !['i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings'].includes(pageMatch[1])) {
    return pageMatch[1].toLowerCase();
  }
  return null;
}


// Determine save type based on URL
function getSaveTypeFromUrl(url) {
  if (!url) return null;

  // Debug: Log the URL being checked
  console.log('X-Track: Checking URL for save type:', url);

  if (url.includes('/Bookmarks')) {
    console.log('X-Track: Matched BOOKMARK pattern');
    return 'BOOKMARK';
  }
  if (url.includes('/Likes')) {
    console.log('X-Track: Matched LIKE pattern');
    return 'LIKE';
  }
  if (url.includes('/UserTweets')) {
    // Only save as MYTWEET if we're on the current user's profile
    const currentUser = getCurrentUserScreenName();
    const profileUser = getUserFromTweetsUrl(url);
    console.log(`X-Track: UserTweets detected - currentUser: ${currentUser}, profileUser: ${profileUser}`);
    if (currentUser && profileUser && currentUser === profileUser) {
      console.log('X-Track: Matched MYTWEET pattern');
      return 'MYTWEET';
    }
    console.log(`X-Track: Skipping UserTweets - profile (${profileUser}) != current user (${currentUser})`);
    return null;
  }
  console.log('X-Track: No save type matched for URL');
  return null; // HomeTimeline, TweetDetail etc. - just cache, don't auto-save
}

// Track already synced tweet IDs to avoid duplicates
const syncedTweetIds = new Set();

function processInterceptedData(data, url) {
  // Try to extract article content from TweetDetail response
  if (url && url.includes('/TweetDetail')) {
    processArticleContentFromTweetDetail(data, url);
  }
  // Also handle separate ArticleDetail endpoint if it exists
  if (url && url.includes('/ArticleDetail')) {
    processArticleContent(data, url);
    return; // Don't process as regular tweets
  }

  const tweets = [];

  // Helper to traverse and find 'Tweet' objects
  function findTweets(obj) {
    if (!obj || typeof obj !== 'object') return;

    // Handle TweetWithVisibilityResults wrapper
    if (obj.__typename === 'TweetWithVisibilityResults' && obj.tweet) {
      const innerTweet = obj.tweet;
      if (innerTweet.rest_id) {
        cacheTweet(innerTweet);
        tweets.push(innerTweet);
      }
      // Also continue traversing in case there are nested tweets
      findTweets(innerTweet);
      return; // Don't traverse obj itself further since we handled the tweet
    }

    // Handle regular Tweet
    if (obj.__typename === 'Tweet' && obj.rest_id) {
      cacheTweet(obj);
      tweets.push(obj);
    }

    // Handle array or object
    if (Array.isArray(obj)) {
      obj.forEach(item => findTweets(item));
    } else {
      for (const key in obj) {
        // Skip already processed tweet property
        if (key === 'tweet' && obj.__typename === 'TweetWithVisibilityResults') continue;
        // Skip nested quoted/retweeted tweets - they are embedded data, not separate entries
        if (key === 'quoted_status_result') continue;
        if (key === 'retweeted_status_result') continue;
        findTweets(obj[key]);
      }
    }
  }

  findTweets(data);

  if (tweets.length > 0) {
    console.log(`X-Track: Cached ${tweets.length} tweets from interception`);

    // Auto-sync based on URL type
    const saveType = getSaveTypeFromUrl(url);
    if (saveType) {
      autoSyncTweets(tweets, saveType);
    }
  }
}

function cacheTweet(tweet) {
  if (!tweet.rest_id) return;

  tweetCache.set(tweet.rest_id, {
    raw: tweet,
    timestamp: Date.now()
  });
  console.log('X-Track: Cached tweet', tweet.rest_id);
}

// Process article content from TweetDetail API response
function processArticleContentFromTweetDetail(data, url) {
  try {
    // Extract tweet ID from URL
    let focalTweetId = null;
    try {
      const urlParams = new URL(url).searchParams;
      const variables = urlParams.get('variables');
      if (variables) {
        const parsed = JSON.parse(variables);
        focalTweetId = parsed.focalTweetId;
      }
    } catch (e) {
      // Ignore parsing errors
    }

    if (!focalTweetId) return;

    // Helper to find article data in a tweet object
    function extractArticleFromTweet(tweet) {
      if (!tweet || typeof tweet !== 'object') return null;

      // Get the actual tweet object
      const actualTweet = tweet.__typename === 'TweetWithVisibilityResults' ? tweet.tweet : tweet;
      if (!actualTweet) return null;

      // Check for article_results
      if (actualTweet.article_results?.result) {
        return {
          tweetId: actualTweet.rest_id,
          articleData: actualTweet.article_results.result
        };
      }

      // Check for article property directly
      if (actualTweet.article) {
        return {
          tweetId: actualTweet.rest_id,
          articleData: actualTweet.article
        };
      }

      // Check for card with article binding
      if (actualTweet.card?.legacy?.binding_values) {
        const bindings = actualTweet.card.legacy.binding_values;
        const cardName = actualTweet.card.legacy.name || '';

        // Check if this is an article card
        if (cardName.includes('article') ||
          bindings.find(b => b.key === 'article_id') ||
          bindings.find(b => b.key === 'content')) {

          // Extract values from bindings
          const getValue = (key) => {
            const binding = bindings.find(b => b.key === key);
            return binding?.value?.string_value || binding?.value?.scribe_value || '';
          };

          const title = getValue('title');
          const description = getValue('description');
          const content = getValue('content');

          if (title || content) {
            return {
              tweetId: actualTweet.rest_id,
              articleData: { title, description, content }
            };
          }
        }
      }

      return null;
    }

    // Find the focal tweet and extract article content
    function findFocalTweetArticle(obj) {
      if (!obj || typeof obj !== 'object') return null;

      // Check if this is our target tweet
      if ((obj.__typename === 'Tweet' || obj.__typename === 'TweetWithVisibilityResults') &&
        (obj.rest_id === focalTweetId || obj.tweet?.rest_id === focalTweetId)) {
        const result = extractArticleFromTweet(obj);
        if (result) return result;
      }

      // Recurse through object
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = findFocalTweetArticle(item);
          if (found) return found;
        }
      } else {
        for (const key in obj) {
          const found = findFocalTweetArticle(obj[key]);
          if (found) return found;
        }
      }
      return null;
    }

    const result = findFocalTweetArticle(data);

    if (result) {
      console.log('X-Track: Found article data in TweetDetail for tweet', result.tweetId);
      console.debug('X-Track Debug: Article data:', JSON.stringify(result.articleData).substring(0, 500));

      // Extract content from article data
      let title = '';
      let content = '';
      const articleData = result.articleData;

      // Handle nested structure: articleData may be { article_results: { result: {...} } }
      const actualArticle = articleData.article_results?.result || articleData;

      title = actualArticle.title || actualArticle.headline || '';

      if (actualArticle.content_blocks) {
        content = actualArticle.content_blocks
          .filter(b => b.type === 'paragraph' || b.type === 'text' || b.text)
          .map(b => b.text || '')
          .join('\n\n');
      } else if (actualArticle.content) {
        content = actualArticle.content;
      } else if (actualArticle.body) {
        content = actualArticle.body;
      } else if (actualArticle.preview_text) {
        content = actualArticle.preview_text;
      } else if (actualArticle.description) {
        content = actualArticle.description;
      }

      if (title || content) {
        // Format: title + newlines + content (no [Article] prefix per user request)
        const articleContent = title ? `${title}\n\n${content}` : content;

        console.log(`X-Track: Updating tweet ${result.tweetId} with article content (${articleContent.length} chars)`);

        chrome.runtime.sendMessage({
          action: 'UPDATE_TWEET_CONTENT',
          data: {
            tweetId: result.tweetId,
            content: articleContent,
            tweetType: 'ARTICLE'
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('X-Track: Error updating article:', chrome.runtime.lastError.message);
          } else if (response?.success) {
            console.log('✅ X-Track: Article content saved');
          }
        });
      } else {
        // API only returned preview, try DOM scraping after a delay
        console.log('X-Track: No full article content in API, will try DOM scraping');
        setTimeout(() => scrapeArticleFromDOM(result.tweetId), 2000);
      }
    } else {
      // Debug: Log available keys in the response to help identify article location
      console.debug('X-Track Debug: No article found for tweet', focalTweetId);
    }
  } catch (e) {
    console.error('X-Track: Error extracting article from TweetDetail:', e);
  }
}

// Scrape full article content from DOM
function scrapeArticleFromDOM(tweetId) {
  console.log('X-Track: Attempting to scrape article content from DOM for tweet', tweetId);

  try {
    // Twitter Articles display in article containers with specific selectors
    // Look for article content elements
    const articleSelectors = [
      '[data-testid="article-viewer-body"]',
      '[data-testid="article-viewer"]',
      'article[data-testid="article"]',
      '[data-testid="richTextBlock"]',
      '.r-pwxb5k [dir="auto"]', // Article text blocks
      '[data-testid="card.layoutLarge.detail"]',
      '[role="article"]'
    ];

    let articleContent = '';
    let articleTitle = '';

    // Try to find article title
    const titleSelectors = [
      '[data-testid="article-header"] h1',
      '[data-testid="article-viewer"] h1',
      'article h1'
    ];

    for (const selector of titleSelectors) {
      const title = document.querySelector(selector);
      if (title && title.textContent) {
        articleTitle = title.textContent.trim();
        break;
      }
    }

    // Try to find article content
    for (const selector of articleSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        const texts = [];
        elements.forEach(el => {
          // Skip if it's navigation or other non-content
          if (el.closest('[role="navigation"]')) return;
          if (el.closest('[data-testid="primaryColumn"]') === null) return;

          const text = el.innerText || el.textContent || '';
          if (text.length > 50) { // Only include substantial text blocks
            texts.push(text.trim());
          }
        });

        if (texts.length > 0) {
          articleContent = texts.join('\n\n');
          break;
        }
      }
    }

    // If we found substantial content, update the tweet
    if (articleContent && articleContent.length > 100) {
      const fullContent = articleTitle ? `${articleTitle}\n\n${articleContent}` : articleContent;

      console.log(`X-Track: Scraped article from DOM (${fullContent.length} chars)`);

      chrome.runtime.sendMessage({
        action: 'UPDATE_TWEET_CONTENT',
        data: {
          tweetId: tweetId,
          content: fullContent,
          tweetType: 'ARTICLE'
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('X-Track: Error updating article from DOM:', chrome.runtime.lastError.message);
        } else if (response?.success) {
          console.log('✅ X-Track: Full article content saved from DOM');
        }
      });
    } else {
      console.log('X-Track: Could not find article content in DOM');
    }
  } catch (e) {
    console.error('X-Track: Error scraping article from DOM:', e);
  }
}

// Process article content from ArticleDetail API
function processArticleContent(data, url) {
  console.log('X-Track: Processing article content from', url);

  try {
    // Find article data in the response
    let articleData = null;
    let tweetId = null;

    // Extract tweet ID from URL if possible
    const urlParams = new URL(url).searchParams;
    const variables = urlParams.get('variables');
    if (variables) {
      try {
        const parsed = JSON.parse(variables);
        tweetId = parsed.tweetId || parsed.articleTweetId;
      } catch (e) {
        // Ignore parsing errors
      }
    }

    // Helper to find article data recursively
    function findArticle(obj) {
      if (!obj || typeof obj !== 'object') return null;

      // Look for article content in various possible paths
      if (obj.article_tweet_results?.result?.article_results?.result) {
        return obj.article_tweet_results.result.article_results.result;
      }
      if (obj.article_results?.result) {
        return obj.article_results.result;
      }
      if (obj.article?.content) {
        return obj.article;
      }
      if (obj.__typename === 'Article' && obj.content) {
        return obj;
      }

      // Recurse through object
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = findArticle(item);
          if (found) return found;
        }
      } else {
        for (const key in obj) {
          const found = findArticle(obj[key]);
          if (found) return found;
        }
      }
      return null;
    }

    articleData = findArticle(data);

    if (articleData) {
      console.log('X-Track: Found article data', articleData);

      // Extract article content
      let title = articleData.title || '';
      let content = '';

      // Extract text from content blocks if available
      if (articleData.content_blocks) {
        const paragraphs = [];
        for (const block of articleData.content_blocks) {
          if (block.type === 'paragraph' || block.type === 'text') {
            paragraphs.push(block.text || '');
          } else if (block.text) {
            paragraphs.push(block.text);
          }
        }
        content = paragraphs.join('\n\n');
      } else if (articleData.content) {
        content = articleData.content;
      } else if (articleData.text) {
        content = articleData.text;
      }

      // Get tweet ID from article data if not found in URL
      if (!tweetId && articleData.tweet_id) {
        tweetId = articleData.tweet_id;
      }

      // Try to find tweet ID from parent tweet data
      if (!tweetId) {
        function findTweetId(obj) {
          if (!obj || typeof obj !== 'object') return null;
          if (obj.rest_id && obj.__typename === 'Tweet') return obj.rest_id;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const found = findTweetId(item);
              if (found) return found;
            }
          } else {
            for (const key in obj) {
              const found = findTweetId(obj[key]);
              if (found) return found;
            }
          }
          return null;
        }
        tweetId = findTweetId(data);
      }

      if (tweetId && (title || content)) {
        const articleContent = title ? `[Article] ${title}\n\n${content}` : content;

        console.log(`X-Track: Updating tweet ${tweetId} with article content (${articleContent.length} chars)`);

        // Send to background script to update the tweet
        chrome.runtime.sendMessage({
          action: 'UPDATE_TWEET_CONTENT',
          data: {
            tweetId: tweetId,
            content: articleContent,
            tweetType: 'ARTICLE'
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('X-Track: Error updating article content:', chrome.runtime.lastError.message);
          } else if (response?.success) {
            console.log('✅ X-Track: Article content saved for tweet', tweetId);
          }
        });
      } else {
        console.warn('X-Track: Could not find tweet ID or content for article');
      }
    } else {
      console.warn('X-Track: Could not find article data in response');
    }
  } catch (e) {
    console.error('X-Track: Error processing article content:', e);
  }
}

// Auto-sync intercepted tweets to database
function autoSyncTweets(tweets, type) {
  const newTweets = [];
  const currentUser = getCurrentUserScreenName();

  // For MYTWEET saves, the user is on their OWN profile, so we can use profile page info
  // to fill in user data when API doesn't provide it (Twitter's UserTweets API doesn't include user data)
  const profileInfo = type === 'MYTWEET' ? getProfilePageUserInfo() : null;

  for (const tweet of tweets) {
    if (!tweet.rest_id) continue;

    const syncKey = `${type}:${tweet.rest_id}`;
    if (syncedTweetIds.has(syncKey)) continue;

    let parsed = parseTweetFromApi(tweet);
    if (parsed) {
      // For MYTWEET: if API didn't provide user data, use profile page info
      // This is correct because MYTWEET saves only happen on user's OWN profile
      if (type === 'MYTWEET' && parsed.handle === 'unknown' && profileInfo && profileInfo.handle) {
        console.log('X-Track Auto-Sync: Enriching MYTWEET with profile page info');
        parsed = {
          ...parsed,
          handle: profileInfo.handle,
          author: profileInfo.name || profileInfo.handle,
          avatarUrl: profileInfo.avatarUrl || parsed.avatarUrl
        };
      }

      // For bookmarks, filter out current user's own tweets (they shouldn't be in bookmarks)
      if (type === 'BOOKMARK' && currentUser && parsed.handle && parsed.handle.toLowerCase() === currentUser) {
        console.log(`X-Track Auto-Sync: Skipping own tweet ${parsed.id} from bookmarks`);
        syncedTweetIds.add(syncKey);
        continue;
      }

      newTweets.push(parsed);
      syncedTweetIds.add(syncKey);
    }
  }

  if (newTweets.length === 0) {
    console.log(`X-Track Auto-Sync: No new tweets to sync for ${type}`);
    return;
  }

  console.log(`X-Track Auto-Sync: Saving ${newTweets.length} ${type}s to database`);

  chrome.runtime.sendMessage({
    action: 'SAVE_BATCH',
    data: {
      type: type,
      tweets: newTweets
    }
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('X-Track Auto-Sync: Runtime error:', chrome.runtime.lastError.message);
      // Remove from synced set so it can be retried
      newTweets.forEach(t => syncedTweetIds.delete(`${type}:${t.id}`));
      return;
    }

    if (response?.success) {
      console.log(`✅ X-Track Auto-Sync: Successfully saved ${response.count} ${type}s`);
    } else {
      console.error('X-Track Auto-Sync: Failed to save:', response?.error);
      // Remove from synced set so it can be retried
      newTweets.forEach(t => syncedTweetIds.delete(`${type}:${t.id}`));
    }
  });
}

function hasChromeRuntime() {
  return typeof chrome !== 'undefined' && !!chrome.runtime;
}

function getChromeStorage() {
  if (typeof chrome === 'undefined') return null;
  if (!chrome.storage || !chrome.storage.local) return null;
  return chrome.storage.local;
}

let storageWarningShown = false;

function ensureChromeStorage(context) {
  const storage = getChromeStorage();
  if (!storage) {
    if (!storageWarningShown) {
      console.warn(`X-Track: Chrome storage API not available${context ? ` (${context})` : ''}. This may be due to extension context invalidation or missing permissions.`);
      storageWarningShown = true;
    }
  }
  return storage;
}

const STAT_KEYWORDS = {
  likes: ['like', 'likes', 'liked', '点赞', '喜歡', '喜欢', '赞', '讚', '좋아요'],
  retweets: ['repost', 'retweet', 'retweets', '转推', '转发', '轉推', '轉發', '리포스트', '리트윗'],
  replies: ['reply', 'replies', 'replying', '回复', '回覆', '评论', '評論', '회신'],
  views: ['view', 'views', '查看', '浏览', '瀏覽', '次查看', '觀看', '조회']
};

function parseCountFromLabel(text) {
  if (!text) return null;
  const normalized = text.replace(/,/g, '').trim();
  if (!normalized) return null;

  const lower = normalized.toLowerCase();
  let multiplier = 1;

  if (/[0-9.]+\s*k/.test(lower)) {
    multiplier = 1000;
  }
  if (/[0-9.]+\s*m/.test(lower)) {
    multiplier = 1000000;
  }
  if (/[0-9.]+\s*b/.test(lower)) {
    multiplier = 1000000000;
  }
  if (normalized.includes('万') || normalized.includes('萬')) {
    multiplier = Math.max(multiplier, 10000);
  }
  if (normalized.includes('千')) {
    multiplier = Math.max(multiplier, 1000);
  }
  if (normalized.includes('亿') || normalized.includes('億')) {
    multiplier = Math.max(multiplier, 100000000);
  }

  const numberMatch = normalized.match(/[\d.]+/);
  if (!numberMatch) return null;
  const value = parseFloat(numberMatch[0]);
  if (Number.isNaN(value)) return null;

  return Math.round(value * multiplier);
}

function extractCountFromElement(el) {
  if (!el) return null;
  const possibleTexts = [];

  if (el.getAttribute) {
    possibleTexts.push(el.getAttribute('aria-label'));
  }

  const counterSpan = el.querySelector?.('[data-testid="app-text-transition-container"]') || el.querySelector?.('span');
  if (counterSpan) {
    possibleTexts.push(counterSpan.textContent);
  }

  possibleTexts.push(el.textContent);

  for (const text of possibleTexts) {
    const parsed = parseCountFromLabel(text);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function getStatValue(articleElement, testIds = [], keywords = []) {
  for (const id of testIds) {
    const el = articleElement.querySelector(`[data-testid="${id}"]`);
    const value = extractCountFromElement(el);
    if (value !== null) {
      return value;
    }
  }

  if (keywords.length > 0) {
    const statNodes = articleElement.querySelectorAll('[role="group"] [aria-label]');
    for (const node of statNodes) {
      const label = node.getAttribute('aria-label') || node.textContent || '';
      const lowerLabel = label.toLowerCase();
      if (keywords.some(keyword => lowerLabel.includes(keyword))) {
        const value = parseCountFromLabel(label);
        if (value !== null) {
          return value;
        }
      }
    }
  }

  return 0;
}

// --- Helper: Extract Full Tweet Text ---
// Uses network-intercepted data when available, falls back to DOM
async function extractFullTweetText(articleElement) {
  const textElement = articleElement.querySelector('div[data-testid="tweetText"]');
  if (!textElement) return '[Image/Video Only]';

  // Check cache first (populated by network interception)
  // Check cache first (populated by network interception)
  const tweetId = extractTweetId(articleElement);
  if (tweetCache.has(tweetId)) {
    const cached = tweetCache.get(tweetId);
    if (cached.raw) {
      const parsed = parseTweetFromApi(cached.raw);
      if (parsed && parsed.content) {
        return parsed.content;
      }
    }
  }

  // Fallback: Use DOM text (may be truncated if not yet loaded)
  // Method 1: Use innerText which preserves line breaks from CSS/BR tags
  // innerText respects CSS styling and converts <br> to newlines
  let fullText = textElement.innerText;

  // Method 2: If innerText didn't work well, try walking the DOM manually
  if (!fullText || fullText.length < 10) {
    const result = [];

    function walkNodes(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent;
          if (text && text.trim() && text.trim() !== '...') {
            result.push(text);
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tagName = child.tagName.toLowerCase();
          // Add newline for block elements and br tags
          if (tagName === 'br') {
            result.push('\n');
          } else if (tagName === 'div' || tagName === 'p') {
            if (result.length > 0 && !result[result.length - 1].endsWith('\n')) {
              result.push('\n');
            }
            walkNodes(child);
            if (result.length > 0 && !result[result.length - 1].endsWith('\n')) {
              result.push('\n');
            }
          } else {
            walkNodes(child);
          }
        }
      }
    }

    walkNodes(textElement);
    fullText = result.join('');
  }

  // Clean up: remove "Show more" text, normalize multiple consecutive newlines to max 2
  fullText = fullText
    .replace(/Show more$/i, '')
    .replace(/[ \t]+/g, ' ')           // Collapse horizontal whitespace only (preserve newlines)
    .replace(/\n{3,}/g, '\n\n')        // Max 2 consecutive newlines
    .replace(/^\s+|\s+$/g, '')         // Trim start and end
    .replace(/ *\n */g, '\n');         // Remove spaces around newlines

  return fullText || '[Image/Video Only]';
}

// --- Helper: Parse Tweet from API (New Mode) ---
function parseTweetFromApi(tweet) {
  try {
    // Handle TweetWithVisibilityResults wrapper
    const actualTweet = tweet.__typename === 'TweetWithVisibilityResults' ? tweet.tweet : tweet;
    if (!actualTweet) {
      console.warn('X-Track: Empty tweet object');
      return null;
    }

    const legacy = actualTweet.legacy || {};

    // Try multiple paths for user data (different endpoints return different structures)
    let userLegacy = null;
    let userResult = actualTweet.core?.user_results?.result;

    // Path 1: Standard path - check legacy first (older API format)
    if (userResult?.legacy?.screen_name) {
      userLegacy = userResult.legacy;
    }
    // Path 1b: NEW API format - screen_name moved to core.user_results.result.core
    else if (userResult?.core?.screen_name) {
      userLegacy = userResult.core;
      // Enhance with avatar from the new location if available
      if (userResult.avatar?.image_url) {
        userLegacy = {
          ...userLegacy,
          profile_image_url_https: userResult.avatar.image_url
        };
      }
    }
    // Path 1c: Handle UserUnavailable - user is suspended/deleted
    else if (userResult?.__typename === 'UserUnavailable') {
      userLegacy = { screen_name: '[unavailable]', name: '[User Unavailable]' };
    }
    // Path 1d: User data at result level without .legacy wrapper
    else if (userResult?.screen_name) {
      userLegacy = userResult;
    }
    // Path 2: UserTweets endpoint structure
    else if (actualTweet.user_results?.result?.legacy?.screen_name) {
      userLegacy = actualTweet.user_results.result.legacy;
    }
    // Path 2b: UserTweets with new format
    else if (actualTweet.user_results?.result?.core?.screen_name) {
      userLegacy = actualTweet.user_results.result.core;
      if (actualTweet.user_results.result.avatar?.image_url) {
        userLegacy = {
          ...userLegacy,
          profile_image_url_https: actualTweet.user_results.result.avatar.image_url
        };
      }
    }
    // Path 2c: Handle UserUnavailable in user_results
    else if (actualTweet.user_results?.result?.__typename === 'UserUnavailable') {
      userLegacy = { screen_name: '[unavailable]', name: '[User Unavailable]' };
    }
    // Path 2d: User data at user_results.result without .legacy
    else if (actualTweet.user_results?.result?.screen_name) {
      userLegacy = actualTweet.user_results.result;
    }
    // Path 3: Alternative user path
    else if (actualTweet.user?.legacy?.screen_name) {
      userLegacy = actualTweet.user.legacy;
    }
    // Path 4: Direct user object
    else if (actualTweet.user?.screen_name) {
      userLegacy = actualTweet.user;
    }
    // Path 5: Check inside core without user_results
    else if (actualTweet.core?.user?.legacy?.screen_name) {
      userLegacy = actualTweet.core.user.legacy;
    }

    // If still no user data, DO NOT use profile page info - that would assign wrong avatar
    // Just use empty object and let it be "unknown" rather than incorrect
    if (!userLegacy || !userLegacy.screen_name) {
      console.warn('X-Track: Could not find user data in expected API paths for tweet:', actualTweet.rest_id);
      // Debug: Log available paths to help identify new API structure
      console.debug('X-Track Debug: Available tweet keys:', Object.keys(actualTweet));
      if (actualTweet.core) console.debug('X-Track Debug: core keys:', Object.keys(actualTweet.core));
      if (actualTweet.core?.user_results) console.debug('X-Track Debug: core.user_results keys:', Object.keys(actualTweet.core.user_results));
      if (actualTweet.core?.user_results?.result) console.debug('X-Track Debug: core.user_results.result keys:', Object.keys(actualTweet.core.user_results.result));
      if (actualTweet.core?.user_results?.result?.legacy) console.debug('X-Track Debug: core.user_results.result.legacy keys:', Object.keys(actualTweet.core.user_results.result.legacy));
      if (actualTweet.core?.user_results?.result?.core) console.debug('X-Track Debug: core.user_results.result.core (NEW):', actualTweet.core.user_results.result.core);
      if (actualTweet.core?.user_results?.result?.avatar) console.debug('X-Track Debug: core.user_results.result.avatar (NEW):', actualTweet.core.user_results.result.avatar);
      userLegacy = {};
    }

    const noteTweet = actualTweet.note_tweet?.note_tweet_results?.result;

    const id = actualTweet.rest_id;
    let handle = userLegacy.screen_name || 'unknown';
    let author = userLegacy.name || handle;
    let avatarUrl = userLegacy.profile_image_url_https || '';

    // Additional avatar fallback paths if not found in userLegacy (only check API paths)
    if (!avatarUrl) {
      // Try core.user_results.result directly
      avatarUrl = actualTweet.core?.user_results?.result?.legacy?.profile_image_url_https ||
        actualTweet.core?.user_results?.result?.profile_image_url_https ||
        actualTweet.user_results?.result?.legacy?.profile_image_url_https ||
        actualTweet.user_results?.result?.profile_image_url_https ||
        actualTweet.user?.profile_image_url_https ||
        '';
    }


    let content = legacy.full_text || '';
    if (noteTweet?.text) {
      content = noteTweet.text;
    }

    const timestamp = legacy.created_at ? new Date(legacy.created_at).toISOString() : new Date().toISOString();

    const likes = legacy.favorite_count || 0;
    const retweets = legacy.retweet_count || 0;
    const replies = legacy.reply_count || 0;
    const views = actualTweet.views?.count ? parseInt(actualTweet.views.count) : 0;

    // Determine tweet type and extract original tweet for retweets
    let tweetType = 'ORIGINAL';
    let retweetedFrom = null;

    if (legacy.in_reply_to_status_id_str) {
      tweetType = 'REPLY';
    } else if (legacy.is_quote_status && actualTweet.quoted_status_result) {
      tweetType = 'QUOTE';
    } else if (legacy.retweeted_status_result) {
      tweetType = 'RETWEET';
      // Extract original tweet info for retweets
      const rtResult = legacy.retweeted_status_result.result;
      if (rtResult) {
        const rtTweet = rtResult.__typename === 'TweetWithVisibilityResults' ? rtResult.tweet : rtResult;
        if (rtTweet) {
          const rtLegacy = rtTweet.legacy || {};
          const rtUserResult = rtTweet.core?.user_results?.result ||
            rtTweet.user_results?.result ||
            rtTweet.user ||
            null;

          // Try new API paths first, then fall back to legacy
          const rtUserCore = rtUserResult?.core || {};
          const rtUserLegacy = rtUserResult?.legacy || rtUserCore || {};
          const rtAvatar = rtUserResult?.avatar || {};

          retweetedFrom = {
            id: rtTweet.rest_id,
            author: rtUserCore.name || rtUserLegacy.name || rtUserLegacy.screen_name || 'unknown',
            handle: rtUserCore.screen_name || rtUserLegacy.screen_name || 'unknown',
            content: rtLegacy.full_text || '',
            avatarUrl: rtAvatar.image_url || rtUserLegacy.profile_image_url_https || ''
          };
          // Use the original tweet's content instead of "RT @..." format
          if (retweetedFrom.content) {
            content = retweetedFrom.content;
          }
        }
      }
    }

    // For quote tweets, also extract the quoted tweet info
    let quotedTweet = null;
    if (tweetType === 'QUOTE' && actualTweet.quoted_status_result?.result) {
      const quoted = actualTweet.quoted_status_result.result;
      // Handle different wrapper types
      let quotedTweetObj = quoted;
      if (quoted.__typename === 'TweetWithVisibilityResults') {
        quotedTweetObj = quoted.tweet;
      } else if (quoted.__typename === 'TweetUnavailable') {
        // Tweet was deleted or unavailable
        quotedTweetObj = null;
      }

      if (quotedTweetObj) {
        const quotedLegacy = quotedTweetObj.legacy || {};
        // Try multiple paths for user data
        const quotedUserResult = quotedTweetObj.core?.user_results?.result ||
          quotedTweetObj.user_results?.result ||
          quotedTweetObj.user ||
          null;

        // Try new API paths first, then fall back to legacy
        const quotedUserCore = quotedUserResult?.core || {};
        const quotedUserLegacy = quotedUserResult?.legacy || quotedUserCore || {};
        const quotedAvatar = quotedUserResult?.avatar || {};

        // Get avatar URL with fallbacks (new API first)
        const quotedAvatarUrl = quotedAvatar.image_url ||
          quotedUserLegacy.profile_image_url_https ||
          quotedUserResult?.profile_image_url_https ||
          '';

        // Get handle with fallbacks (new API first)
        const quotedHandle = quotedUserCore.screen_name ||
          quotedUserLegacy.screen_name ||
          quotedUserResult?.screen_name ||
          quotedLegacy.user_id_str ||
          'unknown';

        // Get name with fallbacks (new API first)
        const quotedAuthor = quotedUserCore.name ||
          quotedUserLegacy.name ||
          quotedUserResult?.name ||
          quotedHandle;

        quotedTweet = {
          id: quotedTweetObj.rest_id || quotedLegacy.id_str,
          author: quotedAuthor,
          handle: quotedHandle,
          content: quotedLegacy.full_text || '',
          avatarUrl: quotedAvatarUrl
        };

        // Silently handle quote tweet user data issues
      }
    }

    // Media
    const media = [];
    const mediaEntities = legacy.entities?.media || [];
    const extendedMedia = legacy.extended_entities?.media || [];

    // Merge media lists, preferring extended
    const allMedia = [...extendedMedia];
    mediaEntities.forEach(m => {
      if (!allMedia.find(am => am.id_str === m.id_str)) {
        allMedia.push(m);
      }
    });

    allMedia.forEach(m => {
      let url = m.media_url_https;
      let type = m.type === 'video' || m.type === 'animated_gif' ? 'video' : 'image';

      if (type === 'video' && m.video_info?.variants) {
        // Find best bitrate video
        const variants = m.video_info.variants.filter(v => v.content_type === 'video/mp4');
        if (variants.length > 0) {
          variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          url = variants[0].url;
        }
      }

      media.push({ url, type, tweetId: id, author: handle });
    });

    // User data issues are common on profile pages, don't spam console

    return {
      id,
      author,
      handle,
      content,
      timestamp,
      avatarUrl,
      likes,
      retweets,
      replies,
      views,
      tweetType,
      retweetedFrom,
      quotedTweet,
      media
    };
  } catch (e) {
    console.error('X-Track: Error parsing API tweet', e);
    return null;
  }
}

// --- Helper: Check if tweet is a promoted/ad tweet ---
function isPromotedTweet(articleElement) {
  if (!articleElement) return false;

  // Method 1: Check for "Promoted" or "Ad" label text
  const promotedLabels = ['Promoted', 'Ad', '推广', '广告', 'プロモーション', '광고'];
  const allText = articleElement.textContent || '';

  // Check for promoted indicator spans
  const spans = articleElement.querySelectorAll('span');
  for (const span of spans) {
    const text = span.textContent?.trim();
    if (text && promotedLabels.includes(text)) {
      return true;
    }
  }

  // Method 2: Check for data-testid containing "promoted" or "ad"
  const promotedElements = articleElement.querySelectorAll('[data-testid*="promoted"], [data-testid*="Promoted"]');
  if (promotedElements.length > 0) {
    return true;
  }

  // Method 3: Check for aria-label containing promoted keywords
  const elementsWithAria = articleElement.querySelectorAll('[aria-label]');
  for (const el of elementsWithAria) {
    const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
    if (ariaLabel.includes('promoted') || ariaLabel.includes('ad') || ariaLabel.includes('推广')) {
      return true;
    }
  }

  // Method 4: Check for specific promoted tweet indicators in the DOM structure
  // Twitter often has a "Promoted" badge with specific styling
  const socialContext = articleElement.querySelector('[data-testid="socialContext"]');
  if (socialContext) {
    const contextText = socialContext.textContent?.toLowerCase() || '';
    if (contextText.includes('promoted') || contextText.includes('推广') || contextText.includes('ad')) {
      return true;
    }
  }

  // Method 5: Check for promoted link patterns
  const links = articleElement.querySelectorAll('a[href*="/i/events/"], a[href*="ads.twitter.com"], a[href*="t.co/"]');
  const hasAdIndicator = articleElement.querySelector('[data-testid="placementTracking"]');
  if (hasAdIndicator) {
    return true;
  }

  return false;
}


// --- Helper: Scrape Tweet Data ---
async function scrapeTweetData(articleElement) {
  try {
    // Skip promoted/ad tweets
    if (isPromotedTweet(articleElement)) {
      console.log('X-Track: Skipping promoted/ad tweet');
      return null;
    }

    const tweetId = extractTweetId(articleElement);

    // 1. Try to get from cache (Network Interception) - PREFERRED
    let apiData = null;
    if (tweetCache.has(tweetId)) {
      const cached = tweetCache.get(tweetId);
      if (cached.raw) {
        apiData = parseTweetFromApi(cached.raw);
      }
    }

    // If API data is perfect, use it
    if (apiData && apiData.handle !== 'unknown') {
      return apiData;
    }

    // Silently fall back to DOM parsing if API data is incomplete or missing


    // 2. Fallback to DOM Scraping (Legacy)
    const userElement = articleElement.querySelector('div[data-testid="User-Name"]');
    const timeElement = articleElement.querySelector('time');

    // Try multiple selectors for avatar (Twitter/X frequently changes DOM structure)
    // Enhanced Avatar Extraction
    let avatarElement = articleElement.querySelector('div[data-testid="Tweet-User-Avatar"] img');
    if (!avatarElement) {
      // Try finding avatar in the user link area
      const userLink = articleElement.querySelector('a[role="link"][href^="/"]');
      if (userLink) {
        avatarElement = userLink.querySelector('img[src*="profile_images"]');
      }
    }
    if (!avatarElement) {
      // Fallback: any img with twimg profile pattern
      avatarElement = articleElement.querySelector('img[src*="twimg.com/profile_images"]');
    }
    if (!avatarElement) {
      // Last resort: first img in the article that looks like a profile pic
      const allImgs = articleElement.querySelectorAll('img');
      for (const img of allImgs) {
        if (img.src && (img.src.includes('profile_images') || img.src.includes('pbs.twimg.com'))) {
          avatarElement = img;
          break;
        }
      }
    }

    // Enhanced Name/Handle Extraction
    let author = 'Unknown';
    let handle = 'unknown';

    if (userElement) {
      const textContent = userElement.innerText;
      // Split by newline and filter out empty strings and dots/separators
      const lines = textContent.split('\n').map(l => l.trim()).filter(l => l && l !== '·' && l !== '•');

      // Name is typically the first line
      if (lines.length > 0) {
        author = lines[0];
      }

      // Handle is typically the line starting with @
      const handleLine = lines.find(l => l.startsWith('@'));
      if (handleLine) {
        handle = handleLine.replace(/^@/, '').split('·')[0].trim();
      } else {
        // Fallback: try to find handle in links if text parsing failed
        const links = userElement.querySelectorAll('a[href^="/"]');
        for (const link of links) {
          const href = link.getAttribute('href');
          // Avoid status links or other non-profile links
          if (href && !href.includes('/status/') && !href.includes('/hashtag/')) {
            handle = href.replace('/', '');
            break;
          }
        }
      }
    }
    // tweetId already extracted at top of function

    // Extract stats (likes/retweets) roughly
    const likes = getStatValue(articleElement, ['like', 'unlike'], STAT_KEYWORDS.likes);
    const retweets = getStatValue(articleElement, ['retweet', 'unretweet'], STAT_KEYWORDS.retweets);
    const replies = getStatValue(articleElement, ['reply'], STAT_KEYWORDS.replies);
    const views = getStatValue(articleElement, ['viewCount', 'tweet-viewport-link'], STAT_KEYWORDS.views);
    const media = extractMediaAttachments(articleElement, tweetId, handle);

    // Check if it is a reply
    // Usually replies have a "Replying to @..." line above the text, or we can infer from context if needed.
    // A simple heuristic: check if there is a "Replying to" text container.
    const replyContext = Array.from(articleElement.querySelectorAll('div')).find(d => d.innerText.includes('Replying to'));
    const isReply = !!replyContext;

    // Extract full tweet text (including truncated parts)
    const content = await extractFullTweetText(articleElement);

    const avatarUrl = avatarElement ? avatarElement.src : '';

    // Debug log for DOM parsing results
    if (!tweetCache.has(tweetId)) {
      console.log(`X-Track DOM Parse: Tweet ${tweetId} - handle: @${handle}, author: ${author}, avatar: ${avatarUrl ? 'found' : 'MISSING'}`);
    }

    const domData = {
      id: tweetId,
      author,
      handle,
      content,
      timestamp: timeElement ? timeElement.getAttribute('datetime') : new Date().toISOString(),
      avatarUrl: avatarElement ? avatarElement.src : '',
      likes,
      retweets,
      replies,
      views,
      isReply,
      media
    };

    // If we have partial API data, merge it (prefer API for content/stats/media, DOM for user info if API failed)
    if (apiData) {
      return {
        ...apiData,
        author: domData.author !== 'Unknown' ? domData.author : apiData.author,
        handle: domData.handle !== 'unknown' ? domData.handle : apiData.handle,
        avatarUrl: domData.avatarUrl || apiData.avatarUrl
      };
    }

    return domData;
  } catch (e) {
    console.error("X-Track: Error scraping tweet", e);
    return null;
  }
}

function extractTweetId(article) {
  // Try to find status link
  const link = article.querySelector('a[href*="/status/"]');
  if (link) {
    const parts = link.href.split('/');
    const statusIndex = parts.indexOf('status');
    if (statusIndex !== -1 && parts[statusIndex + 1]) {
      return parts[statusIndex + 1].split('?')[0]; // Remove query params
    }
  }
  // Fallback: check data-testid
  // Some articles have data-testid="tweet-123456"
  if (article.dataset.testid && article.dataset.testid.startsWith('tweet-')) {
    return article.dataset.testid.replace('tweet-', '');
  }

  return null; // Return null instead of unknown-timestamp to avoid polluting DB with bad data
}

function extractMediaAttachments(article, tweetId, handle) {
  if (!article) return [];

  const media = [];
  const seen = new Set();
  const addMedia = (url, type) => {
    if (!url) return;
    const normalized = url.split('?')[0] || url;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    media.push({ url, type, tweetId, author: handle });
  };

  const imageNodes = article.querySelectorAll('div[data-testid="tweetPhoto"] img, div[data-testid="tweetDetailPhoto"] img, div[data-testid="tweet-media"] img');
  imageNodes.forEach(img => {
    const src = img.currentSrc || img.src;
    addMedia(src, 'image');
  });

  let videoNodes = article.querySelectorAll('div[data-testid="videoPlayer"] video, div[data-testid="tweetGif"] video, div[data-testid="animatedGifPlayable"] video');
  if (!videoNodes.length) {
    videoNodes = article.querySelectorAll('video');
  }
  videoNodes.forEach(video => {
    if (video.closest('article') !== article) return;
    let src = video.currentSrc || video.src;
    if (!src) {
      const sourceEl = video.querySelector('source[src]');
      if (sourceEl) {
        src = sourceEl.src || sourceEl.getAttribute('src');
      }
    }
    addMedia(src, 'video');
  });

  return media;
}

// --- Feature 1: Footprint Tracking (IntersectionObserver) ---

const observerCallback = (entries) => {
  entries.forEach(entry => {
    const tweetId = extractTweetId(entry.target);
    if (!tweetId) return;

    if (entry.isIntersecting) {
      // Tweet entered view
      if (!viewingTimers[tweetId]) {
        viewingTimers[tweetId] = Date.now();
        console.log('X-Track: Tweet entered view:', tweetId);
      }
    } else {
      // Tweet left view
      const startTime = viewingTimers[tweetId];
      if (startTime) {
        const duration = Date.now() - startTime;
        console.log('X-Track: Tweet left view:', tweetId, 'Duration:', duration, 'ms');
        if (duration > DWELL_THRESHOLD) {
          saveFootprint(entry.target, duration);
        }
        delete viewingTimers[tweetId];
      }
    }
  });
};

const observer = new IntersectionObserver(observerCallback, {
  threshold: 0.1, // Lower threshold for earlier detection
  rootMargin: '100px 0px' // Detect tweets 100px before they enter viewport
});

function observeTweet(article) {
  if (!article || article.getAttribute(OBSERVED_ATTR) === 'true') return;
  observer.observe(article);
  article.setAttribute(OBSERVED_ATTR, 'true');
}

function finalizeTweetObservation(article) {
  if (!article) return;
  const tweetId = extractTweetId(article);
  if (tweetId && viewingTimers[tweetId]) {
    const duration = Date.now() - viewingTimers[tweetId];
    if (duration > DWELL_THRESHOLD) {
      saveFootprint(article, duration);
    }
    delete viewingTimers[tweetId];
  }
  try {
    observer.unobserve(article);
  } catch (e) {
    // ignore if not observed
  }
  article.removeAttribute(OBSERVED_ATTR);
}

async function saveFootprint(articleElement, durationMs) {
  console.log('X-Track: saveFootprint() called with duration:', durationMs);

  const tweetData = await scrapeTweetData(articleElement);
  if (!tweetData) {
    console.warn('X-Track: Failed to scrape tweet data');
    return;
  }

  if (!tweetData.id || tweetData.id.startsWith('unknown')) {
    console.warn('X-Track: Skipping save for invalid tweet ID:', tweetData.id);
    return;
  }

  console.log('X-Track: Scraped tweet data:', tweetData);

  // Send to background script for database storage
  try {
    chrome.runtime.sendMessage({
      action: 'SAVE_FOOTPRINT',
      data: {
        tweetData,
        durationMs
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('X-Track: Runtime error:', chrome.runtime.lastError.message);
        return;
      }

      if (response?.success) {
        console.log('✅ X-Track: Footprint saved to IndexedDB');
      } else {
        console.error('X-Track: Failed to save footprint:', response?.error);
      }
    });
  } catch (error) {
    console.error('X-Track: Exception in saveFootprint:', error);
  }
}

// --- Feature 2: Bookmark Syncing ---

function handleBookmarkClick(e) {
  // Find closest tweet article
  const article = e.target.closest('article');
  if (!article) return;

  // Check if it was the bookmark button
  const bookmarkBtn = e.target.closest('[data-testid="bookmark"], [data-testid="removeBookmark"]');
  if (bookmarkBtn) {
    // Wait slightly for UI to update (optional, but good for grabbing correct state if needed)
    setTimeout(async () => {
      const tweetData = await scrapeTweetData(article);
      if (tweetData) {
        saveBookmark(tweetData);
      }
    }, 500);
  }
}

function saveBookmark(tweet) {
  if (!tweet || !tweet.id) {
    console.error("X-Track: Cannot save bookmark, invalid tweet data");
    return;
  }
  console.log("X-Track: Sending SAVE_BOOKMARK message", tweet.id);
  chrome.runtime.sendMessage({
    action: 'SAVE_BOOKMARK',
    data: { tweetData: tweet }
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("X-Track: Runtime error saving bookmark:", chrome.runtime.lastError.message);
      return;
    }
    if (response && response.success) {
      console.log("X-Track: Bookmark Saved", tweet);
    } else {
      console.error("X-Track: Failed to save bookmark", response?.error);
    }
  });
}

// --- Feature 3: Bulk Sync (Message Listener) ---
if (hasChromeRuntime() && getChromeStorage()) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Listen for messages from popup (e.g., to get user info)
    if (request.action === 'GET_USER_INFO') {
      // Extract user info from page
      try {
        let userData = null;

        // Method 1: Check SideNav Account Switcher (Most reliable for logged in user)
        const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
        if (accountSwitcher) {
          const img = accountSwitcher.querySelector('img');
          // Find all spans and look for the one containing @ symbol (that's the handle)
          const allSpans = accountSwitcher.querySelectorAll('span');
          let screenName = '';
          let displayName = '';

          for (const span of allSpans) {
            const text = span.textContent || '';
            if (text.startsWith('@')) {
              screenName = text.replace('@', '');
            } else if (text.trim() && !screenName && !text.includes('@')) {
              // First non-@ text is likely the display name
              displayName = text.trim();
            }
          }

          if (img && screenName) {
            userData = {
              screen_name: screenName,
              name: displayName || img.alt || screenName,
              profile_image_url_https: img.src
            };
            console.log('X-Track: Found user data via Account Switcher', userData);
          }
        }

        // Method 2: Look for user data in scripts (Fallback)
        if (!userData) {
          const scripts = document.querySelectorAll('script');
          for (const script of scripts) {
            const content = script.textContent || '';
            if (content.includes('screen_name') && content.includes('id_str')) {
              const match = content.match(/"screen_name":"([^"]+)".*?"id_str":"(\d+)".*?"name":"([^"]+)"/);
              if (match) {
                userData = {
                  screen_name: match[1],
                  id_str: match[2],
                  name: match[3],
                  profile_image_url_https: `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzMzMyI+PHBhdGggZD0iTTEyIDEyYzIuMjEgMCDoLTEuNzktNC00LTQtMi4yMSAwLTQgMS43OS00IDRzMS43OSA0IDQgNHptMCAyYy0yLjY3IDAtOCAxLjM0LTggNHYyaDE2di0yYzAtMi42Ni01LjMzLTQtOC00eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==` // Fallback image
                };
                break;
              }
            }
          }
        }

        // Method 3: Check for profile link in header (Fallback)
        if (!userData) {
          const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
          if (profileLink) {
            const href = profileLink.getAttribute('href');
            if (href) {
              const screenName = href.replace('/', '');
              userData = {
                screen_name: screenName,
                name: screenName,
                profile_image_url_https: `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzMzMyI+PHBhdGggZD0iTTEyIDEyYzIuMjEgMCDoLTEuNzktNC00LTQtMi4yMSAwLTQgMS43OS00IDRzMS43OSA0IDQgNHptMCAyYy0yLjY3IDAtOCAxLjM0LTggNHYyaDE2di0yYzAtMi42Ni01LjMzLTQtOC00eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==`
              };
            }
          }
        }

        if (userData) {
          sendResponse({ success: true, user: userData });
        } else {
          sendResponse({ success: false, error: 'Could not find user data on page' });
        }
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true; // Keep channel open for async response
    }

    if (request.action === "SYNC_BOOKMARKS") {
      if (window.location.href.includes('/i/bookmarks')) {
        syncVisibleBookmarks().then(count => {
          sendResponse({ success: true, count });
        });
        return true; // Keep channel open for async response
      } else {
        sendResponse({ success: false, error: 'Not on bookmarks page' });
      }
      return true;
    }

    // Start manual scraping (passive collection)
    if (request.action === 'START_MANUAL_SCRAPE') {
      // Use pageType from popup if provided, otherwise detect
      const pageType = request.pageType || detectPageType();
      console.log('X-Track: START_MANUAL_SCRAPE - using pageType:', pageType, '(from request:', request.pageType, ')');

      if (pageType === 'UNKNOWN') {
        sendResponse({ success: false, error: 'Unknown page type. Please navigate to profile, bookmarks, or likes page.' });
      } else {
        startManualCollection(pageType);
        sendResponse({ success: true, mode: 'MANUAL', pageType });
      }
      return true;
    }

    // Start auto scraping (automated with config)
    if (request.action === 'START_AUTO_SCRAPE') {
      // Use pageType from popup if provided, otherwise detect
      const pageType = request.pageType || detectPageType();
      console.log('X-Track: START_AUTO_SCRAPE - using pageType:', pageType, '(from request:', request.pageType, ')');

      if (pageType === 'UNKNOWN') {
        sendResponse({ success: false, error: 'Unknown page type. Please navigate to profile, bookmarks, or likes page.' });
      } else {
        startAutoScraping(pageType, request.config);
        sendResponse({ success: true, mode: 'AUTO', pageType });
      }
      return true;
    }

    // Stop scraping (both modes)
    if (request.action === 'STOP_SCRAPE') {
      if (scrapingState.mode === 'MANUAL') {
        stopManualCollection('User stopped');
      } else if (scrapingState.mode === 'AUTO') {
        stopAutoScraping('User stopped');
      }
      sendResponse({ success: true });
      return true;
    }

    // Get scraping status
    if (request.action === 'GET_SCRAPE_STATUS') {
      sendResponse(getScrapingStatus());
      return true;
    }

    // Update scraping configuration
    if (request.action === 'UPDATE_SCRAPE_CONFIG') {
      if (request.config) {
        scrapingConfig = { ...scrapingConfig, ...request.config };
        saveScrapingConfig();
        sendResponse({ success: true, config: scrapingConfig });
      } else {
        sendResponse({ success: false, error: 'No config provided' });
      }
      return true;
    }

    // Get scraping configuration
    if (request.action === 'GET_SCRAPE_CONFIG') {
      sendResponse({ success: true, config: scrapingConfig });
      return true;
    }
  });

  async function syncVisibleBookmarks() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const tweets = [];

    for (const article of articles) {
      const tweetData = await scrapeTweetData(article);
      if (tweetData) {
        tweets.push(tweetData);
      }
    }

    if (tweets.length > 0) {
      await saveTweetsToStorage(tweets, 'BOOKMARKS');
    }

    return tweets.length;
  }

  // --- Feature 4: Intelligent Page Scraping ---

  // Default scraping configuration (safe defaults)
  let scrapingConfig = {
    mode: 'MANUAL', // 'MANUAL' or 'AUTO'
    auto: {
      minDelay: 1000,
      maxDelay: 2500,
      batchSize: 50,
      maxTweets: 200,
      maxDuration: 10 * 60 * 1000, // 10 minutes
      pauseProbability: 0.2,
      pauseMinDuration: 1500,
      pauseMaxDuration: 4000,
      scrollMinAmount: 300,
      scrollMaxAmount: 800,
      reverseScrollChance: 0.1,
      reverseScrollAmount: 200
    }
  };

  let scrapingState = {
    isActive: false,
    mode: null, // 'MANUAL' or 'AUTO'
    pageType: null,
    scrapedIds: new Set(),
    totalScraped: 0,
    lastScrollHeight: 0,
    noNewContentCount: 0,
    startTime: null,
    lastActionTime: null
  };

  // Load saved configuration
  function loadScrapingConfig() {
    const storage = ensureChromeStorage('loadScrapingConfig');
    if (!storage) return;

    storage.get(['xtrack_scraping_config'], (result) => {
      if (result.xtrack_scraping_config) {
        scrapingConfig = { ...scrapingConfig, ...result.xtrack_scraping_config };
        console.log('X-Track: Loaded scraping config', scrapingConfig);
      }
    });
  }

  // Save configuration
  function saveScrapingConfig() {
    const storage = ensureChromeStorage('saveScrapingConfig');
    if (!storage) return;

    storage.set({ xtrack_scraping_config: scrapingConfig }, () => {
      console.log('X-Track: Saved scraping config');
    });
  }

  // Initialize config on load
  loadScrapingConfig();

  // Detect current page type
  function detectPageType() {
    const url = window.location.href;
    console.log('X-Track: Detecting page type for URL:', url);

    let pageType = 'UNKNOWN';
    if (url.includes('/i/bookmarks')) {
      pageType = 'BOOKMARKS';
    } else if (url.includes('/likes')) {
      pageType = 'LIKES';
    } else if (url.match(/^https?:\/\/(x|twitter)\.com\/[^/]+\/?$/)) {
      // Profile page pattern: x.com/username (but not /status or other subpages)
      pageType = 'PROFILE';
    }

    console.log('X-Track: Detected page type:', pageType);
    return pageType;
  }

  // Random delay to simulate human behavior
  function randomDelay(min, max) {
    const duration = Math.random() * (max - min) + min;
    return new Promise(resolve => setTimeout(resolve, duration));
  }

  // Get delay from config
  function getConfiguredDelay() {
    return randomDelay(scrapingConfig.auto.minDelay, scrapingConfig.auto.maxDelay);
  }

  // Get pause duration from config
  function getConfiguredPause() {
    return randomDelay(scrapingConfig.auto.pauseMinDuration, scrapingConfig.auto.pauseMaxDuration);
  }

  // Human-like smooth scroll with configurable behavior
  async function smoothScroll() {
    const config = scrapingConfig.auto;

    // Very rarely scroll up (5% chance, reduced from 10%)
    if (Math.random() < 0.05) {
      window.scrollBy({
        top: -150,
        behavior: 'smooth'
      });
      await randomDelay(200, 400);
      return;
    }

    // Normal scroll down with variation
    const scrollAmount = Math.random() * (config.scrollMaxAmount - config.scrollMinAmount) + config.scrollMinAmount;
    window.scrollBy({
      top: scrollAmount,
      behavior: 'smooth'
    });

    // Minimal pause after scroll (just enough for smooth scroll animation)
    await randomDelay(150, 300);
  }

  // Validate tweet data has required fields
  function isValidTweetData(tweetData) {
    if (!tweetData) return false;
    if (!tweetData.id || tweetData.id === 'unknown' || tweetData.id.startsWith('unknown-')) {
      console.warn('X-Track: Tweet missing valid ID');
      return false;
    }
    if (!tweetData.handle || tweetData.handle === 'unknown') {
      console.warn(`X-Track: Tweet ${tweetData.id} missing user handle`);
      return false;
    }
    // Log warning for missing avatar but don't reject
    if (!tweetData.avatarUrl) {
      console.warn(`X-Track: Tweet ${tweetData.id} from @${tweetData.handle} missing avatar URL`);
    }
    return true;
  }

  // Extract all visible tweets from current page (parallelized for speed)
  async function extractVisibleTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    // Filter out already scraped articles first (fast sync check)
    const unscrapedArticles = [];
    for (const article of articles) {
      const tweetId = extractTweetId(article);
      if (tweetId && !scrapingState.scrapedIds.has(tweetId)) {
        unscrapedArticles.push(article);
      }
    }

    if (unscrapedArticles.length === 0) {
      return [];
    }

    // Process all unscraped articles in parallel
    const tweetPromises = unscrapedArticles.map(article => scrapeTweetData(article));
    const tweetResults = await Promise.all(tweetPromises);

    const newTweets = [];
    let skippedCount = 0;

    for (const tweetData of tweetResults) {
      if (tweetData && !scrapingState.scrapedIds.has(tweetData.id)) {
        if (isValidTweetData(tweetData)) {
          newTweets.push(tweetData);
          scrapingState.scrapedIds.add(tweetData.id);
        } else {
          skippedCount++;
        }
      }
    }

    if (skippedCount > 0) {
      console.log(`X-Track: Skipped ${skippedCount} tweets due to missing data`);
    }

    return newTweets;
  }

  // Check if new content has loaded (improved detection)
  function hasNewContent() {
    const currentHeight = document.documentElement.scrollHeight;
    const heightChanged = currentHeight > scrapingState.lastScrollHeight;
    scrapingState.lastScrollHeight = currentHeight;

    // Also check if there are any unscraped tweets visible
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    let hasUnscrapedTweets = false;
    for (const article of articles) {
      const tweetId = extractTweetId(article);
      if (tweetId && !scrapingState.scrapedIds.has(tweetId)) {
        hasUnscrapedTweets = true;
        break;
      }
    }

    return heightChanged || hasUnscrapedTweets;
  }

  // --- MANUAL MODE: Passive Collection ---
  // Collects tweets as user naturally scrolls (zero automation)
  let manualCollectionInterval = null;

  function startManualCollection(pageType) {
    if (manualCollectionInterval) {
      console.log('X-Track Manual: Already collecting');
      return;
    }

    // Log network interception status for debugging
    console.log(`X-Track Manual: Network cache status - ${tweetCache.size} tweets cached`);
    if (tweetCache.size === 0) {
      console.warn('X-Track Manual: No cached tweets from network interception. DOM parsing will be used as fallback.');
      console.warn('X-Track Manual: For best results, refresh the page before starting manual collection.');
    }

    scrapingState = {
      isActive: true,
      mode: 'MANUAL',
      pageType: pageType,
      scrapedIds: new Set(),
      totalScraped: 0,
      lastScrollHeight: document.documentElement.scrollHeight,
      noNewContentCount: 0,
      startTime: Date.now(),
      lastActionTime: Date.now()
    };

    console.log(`X-Track Manual: Started passive collection for ${pageType}`);

    // Notify popup
    chrome.runtime.sendMessage({
      action: 'SCRAPE_STARTED',
      data: { mode: 'MANUAL', pageType }
    });

    // Passive collection: check for new tweets every 2 seconds
    manualCollectionInterval = setInterval(async () => {
      const newTweets = await extractVisibleTweets();
      if (newTweets.length > 0) {
        scrapingState.totalScraped += newTweets.length;
        scrapingState.lastActionTime = Date.now();

        console.log(`X-Track Manual: Saving ${newTweets.length} tweets to ${scrapingState.pageType}`);
        saveTweetsToStorage(newTweets, scrapingState.pageType);

        console.log(`X-Track Manual: Collected ${newTweets.length} tweets (Total: ${scrapingState.totalScraped})`);

        // Send progress to popup
        chrome.runtime.sendMessage({
          action: 'SCRAPE_PROGRESS',
          data: {
            mode: 'MANUAL',
            total: scrapingState.totalScraped,
            pageType: scrapingState.pageType
          }
        });
      }
    }, 2000);
  }

  function stopManualCollection(reason = 'User stopped') {
    if (manualCollectionInterval) {
      clearInterval(manualCollectionInterval);
      manualCollectionInterval = null;
    }

    if (!scrapingState.isActive) return;

    const totalCollected = scrapingState.totalScraped;
    scrapingState.isActive = false;
    console.log(`X-Track Manual: Stopped. ${reason}. Collected ${totalCollected} tweets.`);

    // Notify popup
    chrome.runtime.sendMessage({
      action: 'SCRAPE_STOPPED',
      data: {
        mode: 'MANUAL',
        total: totalCollected,
        reason
      }
    });
  }

  // --- AUTO MODE: Intelligent Automated Scraping ---
  // Main auto-scroll scraping loop with configurable behavior
  async function autoScrapePage() {
    // Check if we should continue
    if (!scrapingState.isActive || scrapingState.mode !== 'AUTO') {
      console.log('X-Track Auto: Loop stopped - not active or mode changed');
      updateFloatingButtonState();
      return;
    }

    try {
      scrapingState.lastActionTime = Date.now();

      // Extract current visible tweets
      const newTweets = await extractVisibleTweets();

      // Check stop state after await
      if (!scrapingState.isActive) {
        updateFloatingButtonState();
        return;
      }

      if (newTweets.length > 0) {
        scrapingState.totalScraped += newTweets.length;
        scrapingState.noNewContentCount = 0;

        // Save to appropriate storage based on page type
        console.log(`X-Track Auto: Saving ${newTweets.length} tweets to ${scrapingState.pageType}`);
        await saveTweetsToStorage(newTweets, scrapingState.pageType);

        // Check stop state after await
        if (!scrapingState.isActive) {
          updateFloatingButtonState();
          return;
        }

        console.log(`X-Track Auto: Scraped ${newTweets.length} new tweets (Total: ${scrapingState.totalScraped})`);

        // Update floating button status
        updateFloatingButtonState();

        // Send progress to popup (wrapped in try-catch for when popup is closed)
        try {
          chrome.runtime.sendMessage({
            action: 'SCRAPE_PROGRESS',
            data: {
              mode: 'AUTO',
              total: scrapingState.totalScraped,
              pageType: scrapingState.pageType
            }
          });
        } catch (e) {
          // Popup might be closed, ignore silently
        }
      }

      // Check stop conditions
      if (!scrapingState.isActive) {
        updateFloatingButtonState();
        return;
      }

      const elapsed = Date.now() - scrapingState.startTime;
      const config = scrapingConfig.auto;

      if (scrapingState.totalScraped >= config.maxTweets) {
        console.log('X-Track Auto: Reached tweet limit, stopping.');
        stopAutoScraping(`Completed: Reached ${config.maxTweets} tweets limit`);
        return;
      }

      if (elapsed > config.maxDuration) {
        console.log('X-Track Auto: Reached time limit, stopping.');
        stopAutoScraping(`Completed: Reached time limit`);
        return;
      }

      // Scroll down
      await smoothScroll();

      // Check stop state after await
      if (!scrapingState.isActive) {
        updateFloatingButtonState();
        return;
      }

      // Wait for content to load after scroll (use configured scroll delay)
      const scrollWaitTime = scrapingConfig.auto.scrollWaitTime || 300;
      await randomDelay(scrollWaitTime, scrollWaitTime + 200);

      // Check stop state after await
      if (!scrapingState.isActive) {
        updateFloatingButtonState();
        return;
      }

      // Check if new content loaded
      if (!hasNewContent()) {
        scrapingState.noNewContentCount++;
        console.log(`X-Track Auto: No new content (${scrapingState.noNewContentCount}/10)`);

        // Short wait when no new content appears
        await randomDelay(300, 500);

        // Check stop state after await
        if (!scrapingState.isActive) {
          updateFloatingButtonState();
          return;
        }

        if (scrapingState.noNewContentCount >= 10) {
          console.log('X-Track Auto: Reached end of page, stopping.');
          stopAutoScraping(`Completed: Scraped ${scrapingState.totalScraped} tweets`);
          return;
        }
      }

      // Continue scraping immediately (only if still active)
      if (scrapingState.isActive && scrapingState.mode === 'AUTO') {
        setTimeout(() => autoScrapePage(), 50);
      }

    } catch (error) {
      console.error('X-Track Auto: Error in scrape loop:', error);
      // Don't stop on error, try to continue after a delay (only if still active)
      if (scrapingState.isActive && scrapingState.mode === 'AUTO') {
        setTimeout(() => autoScrapePage(), 1000);
      }
    }
  }

  // Save tweets to storage based on type
  async function saveTweetsToStorage(tweets, pageType) {
    return new Promise((resolve) => {
      let type;
      if (pageType === 'BOOKMARKS') type = 'BOOKMARK';
      else if (pageType === 'LIKES') type = 'LIKE';
      else if (pageType === 'PROFILE') {
        // Check if it's current user's profile or someone else's
        const currentUser = getCurrentUserScreenName();
        const profileUser = getUserFromTweetsUrl(window.location.href);
        if (currentUser && profileUser && currentUser === profileUser) {
          type = 'MYTWEET';
        } else {
          // Save other users' profile tweets as history
          type = 'HISTORY';
          console.log(`X-Track: Saving ${profileUser}'s tweets as HISTORY`);
        }
      }
      else {
        console.warn(`X-Track: Unknown page type "${pageType}", cannot save tweets`);
        return resolve();
      }

      console.log(`X-Track: Sending ${tweets.length} tweets to background for saving (${type})`);

      chrome.runtime.sendMessage({
        action: 'SAVE_BATCH',
        data: {
          type: type,
          tweets: tweets
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('X-Track: Runtime error:', chrome.runtime.lastError.message);
        } else if (response && response.success) {
          console.log(`X-Track: Successfully saved ${response.count} tweets`);
        } else {
          console.error('X-Track: Failed to save tweets:', response?.error);
        }
        resolve();
      });
    });
  }

  // Start auto scraping with configuration
  function startAutoScraping(pageType, config = null) {
    if (scrapingState.isActive) {
      console.log('X-Track Auto: Already scraping');
      return;
    }

    // Update config if provided
    if (config) {
      scrapingConfig.auto = { ...scrapingConfig.auto, ...config };
      saveScrapingConfig();
    }

    scrapingState = {
      isActive: true,
      mode: 'AUTO',
      pageType: pageType,
      scrapedIds: new Set(),
      totalScraped: 0,
      lastScrollHeight: document.documentElement.scrollHeight,
      noNewContentCount: 0,
      startTime: Date.now(),
      lastActionTime: Date.now()
    };

    console.log(`X-Track Auto: Starting automated scraping for ${pageType}`, scrapingConfig.auto);

    // Notify popup
    chrome.runtime.sendMessage({
      action: 'SCRAPE_STARTED',
      data: { mode: 'AUTO', pageType, config: scrapingConfig.auto }
    });

    // Start the loop
    autoScrapePage();
  }

  // Stop auto scraping
  function stopAutoScraping(reason = 'User stopped') {
    if (!scrapingState.isActive) return;

    scrapingState.isActive = false;
    console.log(`X-Track Auto: Stopped. ${reason}`);

    // Notify popup
    chrome.runtime.sendMessage({
      action: 'SCRAPE_STOPPED',
      data: {
        mode: 'AUTO',
        total: scrapingState.totalScraped,
        reason
      }
    });
  }

  // Get scraping status
  function getScrapingStatus() {
    return {
      isActive: scrapingState.isActive,
      mode: scrapingState.mode,
      pageType: scrapingState.pageType,
      totalScraped: scrapingState.totalScraped,
      config: scrapingConfig,
      elapsed: scrapingState.startTime ? Date.now() - scrapingState.startTime : 0
    };
  }

  // --- Floating Scrape Button for Profile Pages ---

  let floatingButton = null;
  let floatingButtonContainer = null;
  let settingsPanel = null;
  let lastCheckedUrl = null;

  // Floating button scrape settings - customizable parameters
  const floatingScrapeSettings = {
    minDelay: 500,      // 最小延迟 (ms)
    maxDelay: 800,      // 最大延迟 (ms)
    scrollDelay: 300,   // 滚动后等待 (ms)
    getDelay: function () {
      return { min: this.minDelay, max: this.maxDelay };
    }
  };

  function createFloatingButton() {
    if (floatingButtonContainer) return;

    // Create container
    floatingButtonContainer = document.createElement('div');
    floatingButtonContainer.id = 'xtrack-floating-container';
    floatingButtonContainer.style.cssText = `
      position: fixed;
      bottom: 100px;
      right: 24px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    // Create status badge
    const statusBadge = document.createElement('div');
    statusBadge.id = 'xtrack-status-badge';
    statusBadge.style.cssText = `
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 8px 14px;
      border-radius: 20px;
      font-size: 13px;
      display: none;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(10px);
    `;

    // Create settings panel
    settingsPanel = document.createElement('div');
    settingsPanel.id = 'xtrack-settings-panel';
    settingsPanel.style.cssText = `
      background: rgba(0, 0, 0, 0.95);
      color: white;
      padding: 16px;
      border-radius: 16px;
      display: none;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(20px);
      min-width: 200px;
    `;
    settingsPanel.innerHTML = `
      <div style="margin-bottom: 12px; font-weight: 600; font-size: 14px;">⚙️ 抓取设置</div>
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <label style="font-size: 12px; color: #aaa; display: block; margin-bottom: 4px;">最小延迟 (毫秒)</label>
          <input type="number" id="xtrack-min-delay" value="${floatingScrapeSettings.minDelay}" min="100" max="5000" step="100" style="
            width: 100%;
            padding: 8px 10px;
            border: 1px solid #444;
            border-radius: 8px;
            background: #222;
            color: white;
            font-size: 14px;
            box-sizing: border-box;
          ">
        </div>
        <div>
          <label style="font-size: 12px; color: #aaa; display: block; margin-bottom: 4px;">最大延迟 (毫秒)</label>
          <input type="number" id="xtrack-max-delay" value="${floatingScrapeSettings.maxDelay}" min="100" max="5000" step="100" style="
            width: 100%;
            padding: 8px 10px;
            border: 1px solid #444;
            border-radius: 8px;
            background: #222;
            color: white;
            font-size: 14px;
            box-sizing: border-box;
          ">
        </div>
        <div>
          <label style="font-size: 12px; color: #aaa; display: block; margin-bottom: 4px;">滚动等待 (毫秒)</label>
          <input type="number" id="xtrack-scroll-delay" value="${floatingScrapeSettings.scrollDelay}" min="100" max="3000" step="100" style="
            width: 100%;
            padding: 8px 10px;
            border: 1px solid #444;
            border-radius: 8px;
            background: #222;
            color: white;
            font-size: 14px;
            box-sizing: border-box;
          ">
        </div>
      </div>
      <div style="margin-top: 8px; font-size: 11px; color: #666;">
        � 延迟越小速度越快，建议最小延迟 ≥ 300ms
      </div>
      <button id="xtrack-start-btn" style="
        width: 100%;
        margin-top: 12px;
        padding: 12px;
        border: none;
        border-radius: 10px;
        background: linear-gradient(135deg, #1d9bf0, #0070d1);
        color: white;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      ">开始抓取</button>
    `;

    // Handle parameter inputs
    settingsPanel.querySelector('#xtrack-min-delay').addEventListener('change', (e) => {
      floatingScrapeSettings.minDelay = parseInt(e.target.value) || 500;
    });
    settingsPanel.querySelector('#xtrack-max-delay').addEventListener('change', (e) => {
      floatingScrapeSettings.maxDelay = parseInt(e.target.value) || 800;
    });
    settingsPanel.querySelector('#xtrack-scroll-delay').addEventListener('change', (e) => {
      floatingScrapeSettings.scrollDelay = parseInt(e.target.value) || 300;
    });

    // Handle start button
    settingsPanel.querySelector('#xtrack-start-btn').addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      startFloatingAutoScrape();
    });

    // Create main button
    floatingButton = document.createElement('button');
    floatingButton.id = 'xtrack-floating-btn';
    floatingButton.title = 'X-Track 抓取';
    floatingButton.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    `;
    floatingButton.style.cssText = `
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1d9bf0, #0070d1);
      color: white;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 16px rgba(29, 155, 240, 0.4);
      transition: all 0.2s ease;
    `;

    floatingButton.addEventListener('mouseenter', () => {
      if (!scrapingState.isActive) {
        floatingButton.style.transform = 'scale(1.1)';
        floatingButton.style.boxShadow = '0 6px 20px rgba(29, 155, 240, 0.5)';
      }
    });

    floatingButton.addEventListener('mouseleave', () => {
      floatingButton.style.transform = 'scale(1)';
      if (!scrapingState.isActive) {
        floatingButton.style.boxShadow = '0 4px 16px rgba(29, 155, 240, 0.4)';
      }
    });

    floatingButton.addEventListener('click', handleFloatingButtonClick);

    floatingButtonContainer.appendChild(statusBadge);
    floatingButtonContainer.appendChild(settingsPanel);
    floatingButtonContainer.appendChild(floatingButton);
    document.body.appendChild(floatingButtonContainer);

    // Close settings when clicking outside
    document.addEventListener('click', (e) => {
      if (settingsPanel && settingsPanel.style.display === 'block' &&
        !settingsPanel.contains(e.target) && e.target !== floatingButton) {
        settingsPanel.style.display = 'none';
      }
    });

    console.log('X-Track: Floating button created');
  }

  function removeFloatingButton() {
    if (floatingButtonContainer) {
      floatingButtonContainer.remove();
      floatingButtonContainer = null;
      floatingButton = null;
      settingsPanel = null;
      console.log('X-Track: Floating button removed');
    }
  }

  let justStopped = false; // Flag to prevent settings panel from opening after stop

  function handleFloatingButtonClick(e) {
    e.stopPropagation();

    if (scrapingState.isActive) {
      // Stop scraping
      justStopped = true;
      stopAutoScraping('User stopped from floating button');
      updateFloatingButtonState();
      // Reset flag after a short delay
      setTimeout(() => { justStopped = false; }, 300);
    } else if (!justStopped) {
      // Toggle settings panel (only if we didn't just stop)
      if (settingsPanel) {
        settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
      }
    }
  }

  function startFloatingAutoScrape() {
    const pageType = detectPageType();
    const targetPageType = (pageType === 'PROFILE' || pageType === 'UNKNOWN') ? 'PROFILE' : pageType;

    // Apply settings to scraping config
    const delay = floatingScrapeSettings.getDelay();
    scrapingConfig.auto.minDelay = delay.min;
    scrapingConfig.auto.maxDelay = delay.max;
    // Also set scroll delay related settings
    scrapingConfig.auto.scrollWaitTime = floatingScrapeSettings.scrollDelay;

    // Start auto scraping
    startAutoScraping(targetPageType);
    updateFloatingButtonState();
  }

  function updateFloatingButtonState() {
    if (!floatingButton) return;

    const statusBadge = document.getElementById('xtrack-status-badge');

    if (scrapingState.isActive) {
      // Active state - show stop icon with red color
      floatingButton.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="6" width="12" height="12" rx="2"/>
        </svg>
      `;
      floatingButton.style.background = 'linear-gradient(135deg, #e74c3c, #c0392b)';
      floatingButton.style.boxShadow = '0 4px 16px rgba(231, 76, 60, 0.5)';
      floatingButton.title = '停止抓取';

      if (statusBadge) {
        statusBadge.textContent = `⏳ 抓取中: ${scrapingState.totalScraped} 条`;
        statusBadge.style.display = 'block';
      }
    } else {
      // Inactive state - show download icon with blue color
      floatingButton.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      `;
      floatingButton.style.background = 'linear-gradient(135deg, #1d9bf0, #0070d1)';
      floatingButton.style.boxShadow = '0 4px 16px rgba(29, 155, 240, 0.4)';
      floatingButton.title = 'X-Track 抓取';

      if (statusBadge) {
        if (scrapingState.totalScraped > 0) {
          statusBadge.textContent = `✅ 已抓取: ${scrapingState.totalScraped} 条`;
          setTimeout(() => {
            if (statusBadge && !scrapingState.isActive) {
              statusBadge.style.display = 'none';
            }
          }, 3000);
        } else {
          statusBadge.style.display = 'none';
        }
      }
    }
  }

  function checkAndShowFloatingButton() {
    const currentUrl = window.location.href;
    if (currentUrl === lastCheckedUrl) return;
    lastCheckedUrl = currentUrl;

    const pageType = detectPageType();

    // Show on profile, bookmarks, and likes pages
    if (pageType === 'PROFILE' || pageType === 'BOOKMARKS' || pageType === 'LIKES') {
      createFloatingButton();
      updateFloatingButtonState();
    } else {
      removeFloatingButton();
    }
  }

  // Watch for URL changes (SPA navigation)
  function setupUrlWatcher() {
    // Check immediately
    checkAndShowFloatingButton();

    // Poll for URL changes (Twitter uses pushState)
    setInterval(checkAndShowFloatingButton, 1000);

    // Also watch for popstate
    window.addEventListener('popstate', checkAndShowFloatingButton);
  }

  // Update button state periodically when scraping
  setInterval(() => {
    if (floatingButton && scrapingState.isActive) {
      updateFloatingButtonState();
    }
  }, 500);

  // --- Initialization ---

  function init() {
    if (isInitialized) return;
    isInitialized = true;

    console.log('X-Track: Initializing content script...');
    console.log('X-Track: DWELL_THRESHOLD set to', DWELL_THRESHOLD, 'ms');
    console.log('X-Track: IntersectionObserver threshold set to 0.5 (50%)');

    // 1. Observe existing tweets
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    console.log(`X-Track: Found ${articles.length} existing tweets on page`);
    articles.forEach(article => observeTweet(article));

    // 2. Observe new tweets loading (Infinite Scroll)
    const bodyObserver = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1) {
            if (node.tagName === 'ARTICLE' && node.getAttribute('data-testid') === 'tweet') {
              console.log('X-Track: New tweet detected, observing...');
              observeTweet(node);
            }
            const newArticles = node.querySelectorAll('article[data-testid="tweet"]');
            if (newArticles.length > 0) {
              console.log(`X-Track: ${newArticles.length} new tweets detected in DOM`);
              newArticles.forEach(a => observeTweet(a));
            }
          }
        });

        mutation.removedNodes.forEach(node => {
          if (node.nodeType === 1) {
            if (node.tagName === 'ARTICLE' && node.getAttribute('data-testid') === 'tweet') {
              finalizeTweetObservation(node);
            }
            const removedArticles = node.querySelectorAll
              ? node.querySelectorAll('article[data-testid="tweet"]')
              : [];
            removedArticles.forEach(a => finalizeTweetObservation(a));
          }
        });
      });
    });

    bodyObserver.observe(document.body, { childList: true, subtree: true });
    console.log('X-Track: MutationObserver attached to body');

    // 3. Periodic scan fallback
    periodicObserverInterval = setInterval(() => {
      document.querySelectorAll('article[data-testid="tweet"]').forEach(article => observeTweet(article));
    }, 4000);
    window.addEventListener('beforeunload', () => {
      if (periodicObserverInterval) {
        clearInterval(periodicObserverInterval);
      }
    });

    // 4. Listen for clicks (Event Delegation)
    document.addEventListener('click', handleBookmarkClick, true);
    console.log('X-Track: Bookmark click listener attached');

    // 5. Setup floating button for profile pages
    setupUrlWatcher();

    console.log('✅ X-Track: Initialization complete!');
  }

  // Run init when page is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
