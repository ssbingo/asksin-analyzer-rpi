import { createRouter, createWebHistory } from 'vue-router';

import { NUR_MASTER, istMaster } from './zustand.ts';

import HomeView from './views/HomeView.vue';
import ListeView from './views/ListeView.vue';
import VerbundView from './views/VerbundView.vue';
import ZigbeeView from './views/ZigbeeView.vue';
import VerbundZigbeeView from './views/VerbundZigbeeView.vue';
import EinstellungenZigbeeView from './views/EinstellungenZigbeeView.vue';
import EinstellungenView from './views/EinstellungenView.vue';
import WartungView from './views/WartungView.vue';
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
    { path: '/zigbee', component: ZigbeeView },
    { path: '/verbund-zigbee', component: VerbundZigbeeView },
    { path: '/settings-zigbee', component: EinstellungenZigbeeView },
    { path: '/settings', component: EinstellungenView },
    { path: '/wartung', component: WartungView },
    { path: '/info', component: InfoView },
    { path: '/:rest(.*)', component: NotFoundView },
  ],
});

/**
 * Verbund-Ansichten gibt es nur auf dem Master.
 *
 * Der Menüpunkt verschwindet dort ohnehin — aber ein Lesezeichen, ein alter
 * Link oder ein von Hand eingetippter Pfad kämen sonst auf einer Seite an, die
 * nichts anzeigen kann. Umgeleitet wird auf die Übersicht.
 *
 * Die Rolle steht erst nach dem ersten health-Abruf fest. Vorher gilt
 * „master" als Vorgabe: Lieber einmal zu viel anzeigen als beim Laden der
 * Seite den Master auf seine eigene Übersicht werfen.
 */
router.beforeEach((nach) => {
  if (!NUR_MASTER.includes(nach.path)) return true;
  return istMaster() ? true : { path: '/home' };
});
