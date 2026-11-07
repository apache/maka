/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
import type { PluginFactory } from '../../shared/plugin.js';
const create: PluginFactory = (ctx) => ({
  suggest: (input, signal) =>
    signal.aborted ? { source: 'local', ids: [] } : ctx.call('model.rank', input),
  run: () => {},
});
export default create;
