import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginAutoPatchFile } from '../plugins/auto-patch-file';
import { config } from './config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

pluginAutoPatchFile({
  docGenIgnoreEntryCheck: false,
  registryUrl: config.registryUrl,
  metaFile: path.resolve(__dirname, '../meta/toolkit.meta.json'),
});
