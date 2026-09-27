/** Compiled by `config-types.test.ts`: each line fails to compile if `get` loses its inference (RC-111). */
import * as config from '../src/config/index.js';

const client = config.init({
  baseUrl: 'https://inlet.test',
  publishableKey: 'ipk_x',
  databaseId: 'cfg_x',
  app: { version: '1' },
  defaults: { flag: false, limit: 3, title: 'Hello', mode: 'a' as const, layout: { columns: 2 }, tags: ['x'] },
});
const flag: boolean = client.get('flag');
const limit: number = client.get('limit');
const title: string = client.get('title');
const mode: string = client.get('mode');
const layout: { columns: number } = client.get('layout');
const tags: string[] = client.get('tags');
// @ts-expect-error a boolean default does not read as a string
const wrong: string = client.get('flag');
// @ts-expect-error a key without a default is not a `get` key
client.get('missing');
const json: { a: number } = client.getJson('x', { a: 1 });
const details: config.ConfigDetails<boolean> = client.getDetails('flag');
const any: config.ConfigDetails = client.getDetails('anything');
export { flag, limit, title, mode, layout, tags, wrong, json, details, any };
