/* eslint-disable no-undef */
import { publishExtension } from 'publish-browser-extension'
import fs from 'fs'
import path from 'path'

// 读取 .build/outputFilename 文件内容
const buildDir = path.join(process.cwd(), '.build')
const outputFilename = fs
  .readFileSync(path.join(buildDir, 'outputFilename'), 'utf-8')
  .trim()

publishExtension({
  dryRun: false,
  chrome: {
    zip: `artifacts/${outputFilename}`,
    extensionId: process.env.CHROME_EXTENSION_ID,
    clientId: process.env.CHROME_CLIENT_ID,
    clientSecret: process.env.CHROME_CLIENT_SECRET,
    refreshToken: process.env.CHROME_REFRESH_TOKEN,
    publishTarget: 'trustedTesters',
    skipSubmitReview: false,
  },
  // firefox: {
  //   zip: 'dist/firefox.zip',
  //   sourcesZip: 'dist/sources.zip',
  //   extensionId: '<addons-extension-id>',
  //   jwtIssuer: '<addons-jwt-issuer>',
  //   jwtSecret: '<addons-jwt-secret>',
  //   channel: '<listed|unlisted>',
  // },
  // edge: {
  //   zip: 'dist/chrome.zip',
  //   productId: '<edge-product-id>',
  //   clientId: '<edge-client-id>',
  //   clientSecret: '<edge-client-secret>',
  //   accessTokenUrl: '<edge-access-token-url>',
  //   skipSubmitReview: false,
  // },
})
  .then((results) => console.log(results))
  .catch((err) => console.error(err))
