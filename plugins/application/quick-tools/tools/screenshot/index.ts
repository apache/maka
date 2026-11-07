/* Licensed under the Apache License, Version 2.0. See LICENSE. */
import { qt } from '../../shared/i18n.js';
import type { PluginFactory } from '../../shared/plugin.js';
const factory: PluginFactory = (context) => ({
  async run(action) {
    if (action === 'capture') await context.call('screenshots.capture', undefined);
    else if (action === 'pin') await context.call('screenshots.pin', undefined);
    else throw Error(qt('未知截图操作'));
  },
});
export default factory;
