(function () {
    // Main World Interceptor
    // This script runs in the page's main context to intercept network requests.

    const XHR = XMLHttpRequest.prototype;
    const open = XHR.open;
    const send = XHR.send;
    const originalFetch = window.fetch;

    // Helper to safely post message to content script
    function postToContentScript(type, data, url) {
        window.postMessage({
            source: 'XTRACK_INJECT',
            type: type,
            url: url,
            data: data
        }, '*');
    }

    // Intercept XMLHttpRequest
    XHR.open = function (method, url) {
        this._url = url;
        return open.apply(this, arguments);
    };

    XHR.send = function (postData) {
        this.addEventListener('load', function () {
            if (this._url && isTargetUrl(this._url)) {
                try {
                    const response = JSON.parse(this.responseText);
                    postToContentScript('XTRACK_INTERCEPT_DATA', response, this._url);
                } catch (e) {
                    // Ignore parsing errors
                }
            }
        });
        return send.apply(this, arguments);
    };

    // Intercept Fetch
    window.fetch = async function (...args) {
        const response = await originalFetch(...args);

        try {
            const url = response.url;
            if (url && isTargetUrl(url)) {
                console.log('X-Track Inject: Intercepted fetch to', url);
                const clone = response.clone();
                clone.json().then(data => {
                    console.log('X-Track Inject: Sending data to content script');
                    postToContentScript('XTRACK_INTERCEPT_DATA', data, url);
                }).catch((e) => {
                    console.warn('X-Track Inject: Failed to parse JSON', e);
                });
            }
        } catch (e) {
            // Ignore errors
        }

        return response;
    };

    function isTargetUrl(url) {
        return (
            url.includes('/TweetDetail') ||
            url.includes('/UserTweets') ||
            url.includes('/Bookmarks') ||
            url.includes('/Likes') ||
            url.includes('/HomeTimeline') ||
            url.includes('/UserMedia') ||
            url.includes('/ArticleDetail')  // Article full content
        );
    }

    console.log('X-Track: Main World Interceptor loaded');
})();
