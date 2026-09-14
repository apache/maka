/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

export const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";

export function loginPageHtml(error: boolean): string {
  const errorHtml = error ? '<p class="error">Could not sign in</p>' : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${LOGIN_CSP}">
  <title>Maka Web</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(28rem, calc(100% - 2rem)); }
    label { display: block; margin: 0.75rem 0 0.25rem; }
    input { width: 100%; box-sizing: border-box; padding: 0.5rem; }
    button { margin-top: 1rem; padding: 0.5rem 1rem; }
    .error { color: #b00020; }
    .hint { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <main>
    <h1>Maka Web</h1>
    ${errorHtml}
    <form method="post" action="/login">
      <label for="passphrase">Passphrase</label>
      <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required minlength="12">
      <label for="otp">Authenticator code</label>
      <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required>
      <button type="submit">Sign in</button>
    </form>
    <p class="hint">Set a passphrase and authenticator in the GUI under Settings → Web access.</p>
    <p class="hint">If chat does not load, start <code>maka-gui</code>.</p>
  </main>
</body>
</html>
`;
}
