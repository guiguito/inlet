/// <reference types="node" />
// Server only: the rest of @inlet/shared compiles without Node types, and a unit test keeps Node out of what the barrel reaches.
import { parentPort } from 'node:worker_threads';
import { schemaJobProblems, type SchemaJob } from './config-check.js';

/**
 * The worker thread of `checkConfigPublish`: runs the schema phase of one publish at a time
 * and posts the index of each parameter before it starts, so that the main thread, which
 * stops it past the time limit, names the parameter whose schema was too slow.
 */
parentPort!.on('message', ({ job, names }: { job: SchemaJob; names: Record<string, string> }) => {
  const done = schemaJobProblems(job, names, (index) => parentPort!.postMessage({ at: index }));
  parentPort!.postMessage({ done });
});
