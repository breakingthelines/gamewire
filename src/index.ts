/**
 * @breakingthelines/gamewire
 *
 * Transform external provider data into BTL's proto schema.
 */

// Core - proto types and utilities
export * from './core/index.js';

// Adapters
export {
  fromStatsBombOpen,
  type FromStatsBombOpenOptions,
} from './adapters/statsbomb-open/index.js';
