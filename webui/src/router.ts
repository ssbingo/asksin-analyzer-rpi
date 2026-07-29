import { createRouter, createWebHistory } from 'vue-router';

import HomeView from './views/HomeView.vue';
import ListeView from './views/ListeView.vue';
import VerbundView from './views/VerbundView.vue';
import EinstellungenView from './views/EinstellungenView.vue';
import InfoView from './views/InfoView.vue';
import NotFoundView from './views/NotFoundView.vue';

/** Routen wie im Original (/home, /list, /settings, /info) — Muskelgedächtnis. */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/home' },
    { path: '/home', component: HomeView },
    { path: '/list', component: ListeView },
    { path: '/verbund', component: VerbundView },
    { path: '/settings', component: EinstellungenView },
    { path: '/info', component: InfoView },
    { path: '/:rest(.*)', component: NotFoundView },
  ],
});
