/**
 * Main World Interceptor
 *
 * This script runs in the page's main context to intercept network requests.
 * It is injected into the page context to bypass content script isolation limitations.
 */

// ============================================================================
// Type Definitions
// ============================================================================

interface PostMessageData {
  source: 'XTRACK_INJECT';
  type: string;
  url: string;
  data: unknown;
}

interface TwitterAPIResponse {
  [key: string]: unknown;
}

// ============================================================================
// Constants
// ============================================================================

const TARGET_API_ENDPOINTS = [
  '/TweetDetail',
  '/UserTweets',
  '/Bookmarks',
  '/Likes',
  '/HomeTimeline',
  '/UserMedia',
  '/ArticleDetail', // Article full content
] as const;

// ============================================================================
// Original Method References
// ============================================================================

const XHR = XMLHttpRequest.prototype;
const originalOpen: typeof XMLHttpRequest.prototype.open = XHR.open;
const originalSend: typeof XMLHttpRequest.prototype.send = XHR.send;
const originalFetch: typeof window.fetch = window.fetch;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely posts a message to the content script
 * @param type - The message type identifier
 * @param data - The intercepted data to send
 * @param url - The URL of the intercepted request
 */
function postToContentScript(
  type: string,
  data: TwitterAPIResponse,
  url: string
): void {
  const message: PostMessageData = {
    source: 'XTRACK_INJECT',
    type,
    url,
    data,
  };
  window.postMessage(message, '*');
}

/**
 * Checks if a URL matches Twitter API endpoints we want to intercept
 * @param url - The URL to check
 * @returns true if the URL should be intercepted
 */
function isTargetUrl(url: string): boolean {
  return TARGET_API_ENDPOINTS.some(endpoint => url.includes(endpoint));
}

// ============================================================================
// XMLHttpRequest Interception
// ============================================================================

/**
 * Override XMLHttpRequest.open to capture the URL
 */
XHR.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...args: [boolean?, string?, string?]): void {
  (this as any)._url = url.toString();
  return originalOpen.apply(this, [method, url, ...args]);
};

/**
 * Override XMLHttpRequest.send to intercept responses
 */
XHR.send = function (this: XMLHttpRequest, postData?: Document | BodyInit | null): void {
  this.addEventListener('load', function (this: XMLHttpRequest) {
    const url = (this as any)._url as string | undefined;

    if (url && isTargetUrl(url)) {
      try {
        const response: TwitterAPIResponse = JSON.parse(this.responseText);
        postToContentScript('XTRACK_INTERCEPT_DATA', response, url);
      } catch (e) {
        // Ignore JSON parsing errors - response might not be JSON
      }
    }
  });
  return originalSend.apply(this, [postData]);
};

// ============================================================================
// Fetch Interception
// ============================================================================

/**
 * Override window.fetch to intercept fetch requests
 */
window.fetch = async function (
  this: Window,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await originalFetch.call(this, input, init);

  try {
    const url = response.url;

    if (url && isTargetUrl(url)) {
      console.log('X-Track Inject: Intercepted fetch to', url);

      // Clone the response to avoid consuming the original stream
      const clonedResponse = response.clone();

      clonedResponse
        .json()
        .then((data: TwitterAPIResponse) => {
          console.log('X-Track Inject: Sending data to content script');
          postToContentScript('XTRACK_INTERCEPT_DATA', data, url);
        })
        .catch((e: unknown) => {
          console.warn('X-Track Inject: Failed to parse JSON', e);
        });
    }
  } catch (e) {
    // Ignore errors during URL checking
  }

  return response;
};

// ============================================================================
// Initialization
// ============================================================================

console.log('X-Track: Main World Interceptor loaded');
