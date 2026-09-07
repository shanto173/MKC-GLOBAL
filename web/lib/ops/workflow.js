/**
 * The operations workflow, for the server.
 *
 * A re-export, not a copy. The implementation lives in public/ops/workflow.js
 * because the console imports it directly in the browser - this project has no
 * build step, so the only way to have ONE status model rather than two is for
 * both runtimes to load the same file.
 *
 * The browser's copy decides what to draw. This copy decides what is allowed.
 * They agree because they are the same code.
 */

export * from '../../public/ops/workflow.js';
