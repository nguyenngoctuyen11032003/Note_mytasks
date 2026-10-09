// Refreshers for user-scoped data cached in the store.
import * as store from '../core/store.js';
import { listCategories } from '../services/categories.js';

export async function reloadCategories() {
  store.set({ categories: await listCategories() });
}
