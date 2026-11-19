import { defineConfig } from 'vite';
import { createWebConfig } from './vite.config.js';

// Select capabilities without changing production .env loading semantics.
export default defineConfig((env) => createWebConfig(env, true));
