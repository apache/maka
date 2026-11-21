---
name: nginx-config-optimizer
description: Optimizes Nginx configurations for performance, security, caching, and load balancing with modern best practices. Use when users request "Nginx setup", "reverse proxy", "load balancer", "web server config", or "Nginx optimization".
---

# Nginx Config Optimizer

Create optimized Nginx configurations for high-performance web serving and reverse proxying.

## Core Workflow

1. **Define architecture**: Reverse proxy, load balancer, or static serving
2. **Configure security**: SSL/TLS, headers, rate limiting
3. **Optimize performance**: Caching, compression, buffers
4. **Setup upstream**: Backend server pools
5. **Add monitoring**: Access logs, metrics
6. **Test configuration**: Validate and reload

## Main Configuration

```nginx
# /etc/nginx/nginx.conf

user nginx;
worker_processes auto;
worker_rlimit_nofile 65535;
pid /run/nginx.pid;

# Load dynamic modules
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 4096;
    multi_accept on;
    use epoll;
}

http {
    # Basic settings
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    server_tokens off;

    # Buffer settings
    client_body_buffer_size 16k;
    client_header_buffer_size 1k;
    client_max_body_size 50m;
    large_client_header_buffers 4 8k;

    # Timeouts
    client_body_timeout 12;
    client_header_timeout 12;
    send_timeout 10;

    # MIME types
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Logging
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    log_format json escape=json '{'
        '"time_local":"$time_local",'
        '"remote_addr":"$remote_addr",'
        '"request":"$request",'
        '"status":$status,'
        '"body_bytes_sent":$body_bytes_sent,'
        '"request_time":$request_time,'
        '"upstream_response_time":"$upstream_response_time",'
        '"http_referer":"$http_referer",'
        '"http_user_agent":"$http_user_agent"'
    '}';

    access_log /var/log/nginx/access.log json;
    error_log /var/log/nginx/error.log warn;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 256;
    gzip_types
        application/atom+xml
        application/javascript
        application/json
        application/ld+json
        application/manifest+json
        application/rss+xml
        application/vnd.geo+json
        application/vnd.ms-fontobject
        application/x-font-ttf
        application/x-web-app-manifest+json
        application/xhtml+xml
        application/xml
        font/opentype
        image/bmp
        image/svg+xml
        image/x-icon
        text/cache-manifest
        text/css
        text/plain
        text/vcard
        text/vnd.rim.location.xloc
        text/vtt
        text/x-component
        text/x-cross-domain-policy
        text/xml;

    # Brotli compression (if module available)
    # brotli on;
    # brotli_comp_level 6;
    # brotli_types text/plain text/css application/json application/javascript;

    # SSL settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    ssl_stapling on;
    ssl_stapling_verify on;

    # Security headers (global)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Rate limiting zones
    limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=api:10m rate=100r/s;
    limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
    limit_conn_zone $binary_remote_addr zone=addr:10m;

    # Proxy cache
    proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=STATIC:10m inactive=7d use_temp_path=off max_size=1g;

    # Include site configs
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
```

## Reverse Proxy Configuration

```nginx
# /etc/nginx/sites-available/app.conf

upstream backend {
    least_conn;
    keepalive 32;

    server 10.0.1.10:3000 weight=5;
    server 10.0.1.11:3000 weight=5;
    server 10.0.1.12:3000 weight=5 backup;

    # Health checks (Nginx Plus or OpenResty)
    # health_check interval=5s fails=3 passes=2;
}

upstream api {
    ip_hash;
    keepalive 64;

    server 10.0.2.10:8080 max_fails=3 fail_timeout=30s;
    server 10.0.2.11:8080 max_fails=3 fail_timeout=30s;
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name example.com www.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# Main HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name example.com www.example.com;

    # SSL certificates
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/example.com/chain.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://api.example.com wss://example.com" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # Rate limiting
    limit_req zone=general burst=20 nodelay;
    limit_conn addr 10;

    # Root and error pages
    root /var/www/html;
    error_page 500 502 503 504 /50x.html;

    # Static files with caching
    location /static/ {
        alias /var/www/static/;
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # Next.js static files
    location /_next/static/ {
        alias /var/www/app/.next/static/;
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # Proxy to backend
    location / {
        proxy_pass http://backend;
        proxy_http_version 1.1;

        # Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Keepalive
        proxy_set_header Connection "";

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # Buffering
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
        proxy_busy_buffers_size 8k;

        # Cache settings for specific responses
        proxy_cache STATIC;
        proxy_cache_valid 200 1h;
        proxy_cache_valid 404 1m;
        proxy_cache_bypass $http_cache_control;
        add_header X-Cache-Status $upstream_cache_status;
    }

    # API endpoints
    location /api/ {
        limit_req zone=api burst=50 nodelay;

        proxy_pass http://api/;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # Longer timeout for API
        proxy_read_timeout 120s;

        # No caching for API
        proxy_cache off;
        add_header Cache-Control "no-store";
    }

    # Login rate limiting
    location /api/auth/login {
        limit_req zone=login burst=5 nodelay;

        proxy_pass http://api/auth/login;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket endpoint
    location /ws {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Health check endpoint
    location /health {
        access_log off;
        return 200 'OK';
        add_header Content-Type text/plain;
    }

    # Deny access to sensitive files
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }

    location ~ ^/(\.env|composer\.json|package\.json|yarn\.lock) {
        deny all;
    }
}
```

## Load Balancer Configuration

```nginx
# /etc/nginx/conf.d/load-balancer.conf

upstream app_cluster {
    # Load balancing methods:
    # round_robin (default)
    # least_conn - least number of active connections
    # ip_hash - session persistence by IP
    # hash $request_uri consistent - consistent hashing

    least_conn;

    server 10.0.1.10:3000 weight=10 max_fails=3 fail_timeout=30s;
    server 10.0.1.11:3000 weight=10 max_fails=3 fail_timeout=30s;
    server 10.0.1.12:3000 weight=5 max_fails=3 fail_timeout=30s;
    server 10.0.1.13:3000 backup;

    keepalive 100;
}

# Active health checks (Nginx Plus)
# match server_ok {
#     status 200-399;
#     body ~ "OK";
# }

server {
    listen 443 ssl http2;
    server_name app.example.com;

    ssl_certificate /etc/nginx/ssl/app.crt;
    ssl_certificate_key /etc/nginx/ssl/app.key;

    location / {
        proxy_pass http://app_cluster;
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # Sticky sessions using cookie
        # sticky cookie srv_id expires=1h domain=.example.com path=/;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_next_upstream error timeout http_500 http_502 http_503 http_504;
        proxy_next_upstream_tries 3;
        proxy_next_upstream_timeout 10s;

        # Health check (Nginx Plus)
        # health_check match=server_ok interval=5s fails=3 passes=2;
    }
}
```

## Caching Configuration

```nginx
# /etc/nginx/conf.d/cache.conf

# FastCGI cache (for PHP)
fastcgi_cache_path /var/cache/nginx/fastcgi levels=1:2 keys_zone=FASTCGI:100m inactive=60m max_size=1g;
fastcgi_cache_key "$scheme$request_method$host$request_uri";

# Proxy cache for static content
proxy_cache_path /var/cache/nginx/proxy
    levels=1:2
    keys_zone=PROXY:100m
    inactive=7d
    max_size=10g
    use_temp_path=off;

# Microcaching for dynamic content
proxy_cache_path /var/cache/nginx/micro
    levels=1:2
    keys_zone=MICRO:10m
    inactive=1m
    max_size=100m;

map $request_uri $cache_bypass {
    default 0;
    ~*^/api/ 1;
    ~*^/admin/ 1;
}

server {
    listen 443 ssl http2;
    server_name cdn.example.com;

    # Serve cached static files
    location ~* \.(jpg|jpeg|png|gif|ico|css|js|woff2|woff|ttf|svg|webp|avif)$ {
        proxy_pass http://origin;
        proxy_cache PROXY;
        proxy_cache_valid 200 30d;
        proxy_cache_valid 404 1m;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;
        proxy_cache_lock on;

        add_header X-Cache-Status $upstream_cache_status;
        add_header Cache-Control "public, max-age=2592000, immutable";

        expires 30d;
    }

    # Microcaching for HTML
    location / {
        proxy_pass http://backend;
        proxy_cache MICRO;
        proxy_cache_valid 200 1s;
        proxy_cache_bypass $cache_bypass;
        proxy_no_cache $cache_bypass;
        proxy_cache_use_stale updating;
        proxy_cache_background_update on;

        add_header X-Cache-Status $upstream_cache_status;
    }
}
```

## Security Hardening

```nginx
# /etc/nginx/conf.d/security.conf

# Block bad bots
map $http_user_agent $bad_bot {
    default 0;
    ~*malicious 1;
    ~*scanner 1;
    ~*bot 1;
}

# Block by IP (geo module)
geo $blocked_ip {
    default 0;
    10.0.0.0/8 0;      # Allow internal
    192.168.0.0/16 0;  # Allow internal
    # 1.2.3.4 1;       # Block specific IP
}

# Rate limiting by request type
map $request_method $limit_key {
    POST    $binary_remote_addr;
    default "";
}

limit_req_zone $limit_key zone=post_limit:10m rate=5r/s;

server {
    # Reject bad bots
    if ($bad_bot) {
        return 403;
    }

    # Reject blocked IPs
    if ($blocked_ip) {
        return 403;
    }

    # Block common attack patterns
    location ~* "(eval\(|base64_|javascript:)" {
        return 403;
    }

    location ~* "(\.\./|\.\.\\)" {
        return 403;
    }

    # Limit POST requests
    location / {
        limit_req zone=post_limit burst=10 nodelay;
        # ... rest of config
    }

    # Fail2ban integration - log failed attempts
    location /api/auth {
        access_log /var/log/nginx/auth.log;
        # ... rest of config
    }
}
```

## Docker Nginx Configuration

```nginx
# nginx/nginx.conf for Docker

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Logging to stdout/stderr for Docker
    access_log /dev/stdout;
    error_log /dev/stderr warn;

    upstream app {
        server app:3000;
    }

    server {
        listen 80;

        location / {
            proxy_pass http://app;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
    }
}
```

```dockerfile
# Dockerfile
FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=3s \
    CMD wget --quiet --tries=1 --spider http://localhost/health || exit 1
```

## Testing Configuration

```bash
# Test configuration syntax
nginx -t

# Test configuration with specific file
nginx -t -c /etc/nginx/nginx.conf

# Check configuration details
nginx -T

# Reload configuration without downtime
nginx -s reload

# Test with curl
curl -I https://example.com
curl -w "@curl-format.txt" -o /dev/null -s https://example.com

# Test SSL configuration
openssl s_client -connect example.com:443 -servername example.com

# Test HTTP/2
curl --http2 -I https://example.com
```

## Best Practices

1. **Worker processes**: Set to `auto` for CPU cores
2. **Keepalive connections**: Enable for upstreams
3. **Gzip compression**: Enable for text content
4. **SSL/TLS**: Use TLS 1.2+ only
5. **Security headers**: Add HSTS, CSP, etc.
6. **Rate limiting**: Protect against abuse
7. **Buffer tuning**: Optimize for traffic patterns
8. **Caching**: Use proxy cache for static content

## Output Checklist

Every Nginx configuration should include:

- [ ] Worker process optimization
- [ ] Gzip compression enabled
- [ ] SSL/TLS with modern ciphers
- [ ] Security headers (HSTS, CSP, X-Frame-Options)
- [ ] Rate limiting zones
- [ ] Upstream keepalive connections
- [ ] Proper logging (JSON format)
- [ ] Health check endpoints
- [ ] Static file caching
- [ ] Proxy buffering tuned
- [ ] Error pages configured
- [ ] Configuration tested with `nginx -t`
