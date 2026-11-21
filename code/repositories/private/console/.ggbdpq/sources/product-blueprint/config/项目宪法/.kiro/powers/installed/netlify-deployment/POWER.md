---
name: "netlify-deployment"
displayName: "Netlify Deployment"
description: "Deploy and manage websites on Netlify using CLI-first workflow with netlify.toml configuration"
keywords: ["netlify", "deploy", "hosting", "cli", "deployment", "web", "static-site"]
author: "Netlify"
---

Netlify Deployment (CLI-First)
==============================

> Use this file whenever you are asked to deploy or update a site on Netlify. **Default behavior:** prefer the Netlify CLI

1\. Defaults & Principles
-------------------------

*   Prefer **Netlify CLI** as the primary deployment method.
*   Use a netlify.toml file for consistent build and publish configuration.
*   Never hardcode secrets; always use **Netlify environment variables**.
*   For framework-specific details, reference official Netlify docs (via llms.txt) rather than inventing new patterns.

2\. netlify.toml Basics
-----------------------

```
[build]
  command = "BUILD_COMMAND"
  publish = "PUBLISH_DIRECTORY"
```

*   Adjust publish to match the actual output directory.
*   Use SPA redirect only for client-side routed apps.
*   Do not include secrets.
    

3\. Deploy with Netlify CLI (Preferred)
---------------------------------------

### Install & Authenticate

```
npm install -g netlify-cli

# will tell you linked status and user status
netlify status

#only if the user is not logged in
netlify login 
```

### Link or Create a Site

Determine if the site is linked to an existing Netlify account with `netlify status`

Skip this step if it is already linked.

If not already linked:
1. determine if it is git based
   1.a. if it is git based, use `git remote show origin` to find the git remote url like "https://github.com/orgname/reponame"
   1.b. see if the site already exists on their account with `netlify link --git-remote-url REMOTE_URL`
   1.c. if the site is not found then we must create it.
2. if site is unknown, create a new site use `netlify init` and let the user walk through the steps


### Dependencies

Confirm that all dependencies have been installed. (e.g. `npm install`)

### Deploy

If the user created a new site, then do a production deploy. If this is linking an existing site, we must create a preview/non-production deploy unless the user expclitly asked for this.

non-production deploy:
`netlify deploy`

production deploy:
`netlify deploy --prod`

    
4\. Troubleshooting Basics
--------------------------

*   Check Netlify build logs for errors.
*   Confirm correct build command and publish directory.
*   Verify required environment variables exist.
