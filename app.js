"use strict";
/* Pilotage de La Nuit des Bleus.
 *
 * L'appli ne contient aucune donnée : tout est lu dans le dépôt privé (branche
 * « contenus ») avec le code d'accès saisi au premier lancement, qui reste sur le
 * téléphone. Sans ce code, on ne voit que l'écran de connexion.
 *
 * Les choix (garder ou non un encart, retirer ou déplacer une image…) ne relancent
 * aucune fabrication : toutes les variantes sont déjà rendues, l'appli les assemble.
 */

const API = "https://api.github.com";
const WORKFLOW = "matin.yml";
const REGLAGES = "reglages.yml";
const CITATIONS = "citations.yml";
const CLES = { jeton: "ndb.jeton", depot: "ndb.depot", publie: "ndb.publie", generation: "ndb.generation",
               veille: "ndb.veille", mercatoGen: "ndb.mercatoGen", mercatoVeille: "ndb.mercatoVeille",
               mercatoEcartes: "ndb.mercatoEcartes" };
const $app = document.getElementById("app");

const etat = {
  jeton: lire(CLES.jeton), depot: lire(CLES.depot),
  fiche: null, fichiers: {}, urls: {}, choix: {}, legendeModifiee: {},
  ordre: {}, retirees: new Set(), ton: {}, tagsRetires: {}, minuterie: null,
};

/* ------------------------------------------------------------------ outils */

function lire(cle) { try { return localStorage.getItem(cle); } catch { return null; } }
function garder(cle, valeur) {
  try { valeur == null ? localStorage.removeItem(cle) : localStorage.setItem(cle, valeur); } catch { /* navigation privée */ }
}
function lireJSON(cle, defaut) { try { return JSON.parse(lire(cle)) ?? defaut; } catch { return defaut; } }

function el(tag, attrs = {}, ...enfants) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "texte") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const e of enfants.flat()) {
    if (e == null || e === false) continue;
    n.append(e instanceof Node ? e : document.createTextNode(String(e)));
  }
  return n;
}

function afficher(...noeuds) {
  // listes aplaties, blocs absents (null) ignorés : sinon ils s'afficheraient en texte
  $app.replaceChildren(...noeuds.flat(Infinity).filter((n) => n != null && n !== false));
  window.scrollTo(0, 0);
}

function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.classList.add("vu");
  clearTimeout(toast.minuterie);
  toast.minuterie = setTimeout(() => t.classList.remove("vu"), 2800);
}

function entete(titre, sousTitre, { retour = false, droite = null } = {}) {
  return el("header", { class: "entete" },
    retour
      ? el("button", { class: "icone", "aria-label": "Retour", onclick: () => history.length > 1 ? history.back() : (location.hash = "#/") }, "←")
      : el("img", { class: "logo", src: "icones/icone-192.png", alt: "" }),
    el("h1", {}, titre, sousTitre ? el("small", { texte: sousTitre }) : null),
    droite);
}

function resumeTexte(r) {
  if (!r || r.joueurs == null) return "";
  return `${r.joueurs} Français · ${r.matchs} match${r.matchs > 1 ? "s" : ""} · ${r.victoires}V-${r.defaites}D`;
}

const fmtJour = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(d);

/** La nuit NBA en cours de traitement : heure de New York moins 6 h. */
function nuitNBA() {
  const d = new Date(Date.now() - 6 * 3600e3);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

/** La nuit qui devrait être prête maintenant : celle d'hier à partir de 7h15 à Paris. */
function nuitAttendue() {
  const heure = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).find((p) => p.type === "hour").value);
  const recul = heure >= 7 ? 1 : 2;
  return fmtJour(new Date(Date.now() - recul * 86400e3));
}

const heureCourte = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/* --- publications déjà faites, mémorisées sur ce téléphone --- */

function publiees() { return lireJSON(CLES.publie, {}); }
function estPubliee(nuit, pub) { return Boolean(publiees()[nuit]?.[pub]); }
function marquerPubliee(nuit, pub, oui) {
  const p = publiees();
  if (oui) (p[nuit] ||= {})[pub] = new Date().toISOString();
  else if (p[nuit]) { delete p[nuit][pub]; if (!Object.keys(p[nuit]).length) delete p[nuit]; }
  // on ne garde que les 30 dernières nuits
  const cles = Object.keys(p).sort().reverse();
  for (const vieille of cles.slice(30)) delete p[vieille];
  garder(CLES.publie, JSON.stringify(p));
}

/* ------------------------------------------------------------------ GitHub */

async function gh(chemin, { methode = "GET", corps, accept = "application/vnd.github+json" } = {}) {
  const r = await fetch(API + chemin, {
    method: methode, cache: "no-store",
    headers: {
      Authorization: `Bearer ${etat.jeton}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28",
      ...(corps ? { "Content-Type": "application/json" } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (r.status === 401) { deconnecter("Code d'accès refusé ou expiré."); throw new Error("401"); }
  if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
  return r;
}

const encoder = (chemin) => chemin.split("/").map(encodeURIComponent).join("/");

function contenu(chemin) {
  return gh(`/repos/${etat.depot}/contents/${encoder(chemin)}?ref=contenus`,
            { accept: "application/vnd.github.raw" });
}

/** Le dépôt privé que ce code ouvre : celui qui a une branche « contenus ». */
async function trouverDepot() {
  const depots = await (await gh("/user/repos?per_page=100&sort=updated")).json();
  for (const d of depots.filter((d) => d.private)) {
    const b = await fetch(`${API}/repos/${d.full_name}/branches/contenus`, {
      headers: { Authorization: `Bearer ${etat.jeton}`, Accept: "application/vnd.github+json" },
    });
    if (b.ok) return d.full_name;
  }
  throw new Error("Ce code n'ouvre aucun espace de contenus. Vérifiez le dépôt autorisé.");
}

async function dernierLancement() {
  const r = await (await gh(`/repos/${etat.depot}/actions/workflows/${WORKFLOW}/runs?per_page=1`)).json();
  return r.workflow_runs[0] || null;
}

function deconnecter(message) {
  etat.jeton = etat.depot = null;
  garder(CLES.jeton, null); garder(CLES.depot, null);
  ecranConnexion(message);
}

/* ------------------------------------------------------------------ écrans */

function ecranConnexion(message) {
  const champ = el("input", { type: "password", id: "code", autocomplete: "off", autocapitalize: "off",
                              spellcheck: "false", placeholder: "Collez votre code" });
  const erreur = el("p", { class: "erreur", texte: message || "" });
  const bouton = el("button", { class: "btn principal", type: "submit" }, "Entrer");
  const formulaire = el("form", {
    class: "connexion",
    onsubmit: async (e) => {
      e.preventDefault();
      bouton.disabled = true; erreur.textContent = "";
      try {
        etat.jeton = champ.value.trim();
        if (!etat.jeton) throw new Error("Entrez le code d'accès.");
        etat.depot = await trouverDepot();
        garder(CLES.jeton, etat.jeton); garder(CLES.depot, etat.depot);
        location.hash = "#/"; router();
      } catch (x) {
        if (x.message !== "401") erreur.textContent = x.message;
        etat.jeton = null; bouton.disabled = false;
      }
    },
  },
    el("img", { src: "icones/icone-192.png", alt: "" }),
    el("h1", {}, "La nuit", el("br"), el("span", { texte: "des Bleus" })),
    el("div", { class: "champ" }, el("label", { for: "code", texte: "Code d'accès" }), champ),
    erreur, bouton);
  afficher(formulaire);
}

/* --- accueil : l'état du matin, puis les nuits --- */

function carteEtat(index) {
  const zone = el("div", { class: "carte etat" }, el("p", { class: "aide", texte: "État du matin…" }));
  (async () => {
    const attendue = nuitAttendue();
    const prete = (index.nuits || []).find((n) => n.nuit === attendue);
    let run = null;
    try { run = await dernierLancement(); } catch (x) { if (x.message === "401") return; }
    const enCours = run && run.status !== "completed";
    let voyant, titre, detail, action = null;
    if (prete) {
      const fait = estPubliee(prete.nuit, "carrousel");
      voyant = fait ? "ok" : "fluo";
      titre = fait ? "Publiée ✓" : "Prête à publier";
      detail = `Nuit du ${prete.date_fr} · générée à ${heureCourte(prete.genere_le)}`;
      action = el("button", { class: "btn principal", onclick: () => (location.hash = `#/nuit/${prete.nuit}`) },
        fait ? "Revoir" : "Ouvrir");
    } else if (enCours) {
      voyant = "encours"; titre = "En préparation…";
      detail = `Lancement ${run.event === "schedule" ? "automatique" : "manuel"} de ${heureCourte(run.created_at)}`;
    } else if (run && run.conclusion === "failure") {
      voyant = "ko"; titre = "Échec du dernier lancement";
      detail = `${heureCourte(run.created_at)} : la nuit n'a pas été produite.`;
      action = el("button", { class: "btn", onclick: () => (location.hash = "#/relancer") }, "Relancer");
    } else if (run && run.conclusion === "success" && fmtJour(new Date(run.created_at)) === fmtJour(new Date())
               && new Date(run.created_at).getUTCHours() >= 5) {
      voyant = "neutre"; titre = "Rien à publier";
      detail = "Le lancement du matin a réussi, mais aucun Français n'a joué cette nuit.";
    } else {
      voyant = "neutre"; titre = "Pas encore prête";
      detail = "Le carrousel arrive en général vers 7h15.";
    }
    zone.replaceChildren(...[
      el("div", { class: "etat-tete" }, el("span", { class: `voyant ${voyant}` }), el("strong", { texte: titre })),
      el("p", { class: "aide", texte: detail }), action].filter(Boolean));
  })();
  return zone;
}

async function ecranListe() {
  const boutons = el("div", { class: "boutons-tete" },
    el("button", { class: "icone texte", "aria-label": "Citations", onclick: () => (location.hash = "#/citations") }, "Citations"),
    el("button", { class: "icone texte", "aria-label": "Mercato", onclick: () => (location.hash = "#/mercato") }, "Mercato"),
    el("button", { class: "icone texte", "aria-label": "Les Bleus", onclick: () => (location.hash = "#/bleus") }, "Bleus"),
    el("button", { class: "icone", "aria-label": "Réglages", onclick: () => (location.hash = "#/relancer") }, "⚙"));
  const tete = entete("La nuit des Bleus", "Pilotage", { droite: boutons });
  afficher(tete, el("p", { class: "aide", texte: "Chargement…" }));
  let index;
  try {
    index = await (await contenu("index.json")).json();
  } catch (x) {
    if (x.message === "401") return;
    afficher(tete, el("div", { class: "carte alerte" }, el("p", { texte: `Impossible de lire les contenus : ${x.message}` })));
    return;
  }
  const cartes = (index.nuits || []).map((n) => el("button", {
    class: "carte nuit", onclick: () => (location.hash = `#/nuit/${n.nuit}`),
  },
    el("span", { class: "date", texte: n.date_fr || n.nuit }),
    el("span", { class: "meta", texte: resumeTexte(n.resume) }),
    el("span", { class: "pastilles" },
      estPubliee(n.nuit, "carrousel") ? el("span", { class: "pastille fluo", texte: "Publiée ✓" }) : null,
      el("span", { class: "pastille", texte: `${n.images} images` }),
      n.choix ? el("span", { class: "pastille", texte: n.choix > 1 ? `${n.choix} choix` : "1 choix" }) : null,
      n.alertes ? el("span", { class: "pastille rouge", texte: "à vérifier" }) : null)));
  let recaps = [], ladders = [];
  try { recaps = (await (await contenu("recaps/index.json")).json()).recaps || []; }
  catch (x) { if (x.message === "401") return; }
  try { ladders = (await (await contenu("ladders/index.json")).json()).editions || []; }
  catch (x) { if (x.message === "401") return; }
  let mouvements = [];
  try { mouvements = (await (await contenu("mercato/index.json")).json()).mouvements || []; }
  catch (x) { if (x.message === "401") return; }
  afficher(tete, carteEtat(index),
    mouvements.length ? sectionMercato(mouvements) : null,
    recaps.length ? el("section", { class: "section" }, el("h2", { texte: "La semaine des Bleus" }),
      el("div", { class: "liste" }, recaps.slice(0, 2).map((r) => el("button", {
        class: "carte nuit", onclick: () => (location.hash = `#/production/${encodeURIComponent(r.dossier)}`),
      },
        el("span", { class: "date", texte: r.titre.replace("La semaine des Bleus · ", "Semaine ") }),
        el("span", { class: "pastilles" },
          estPubliee(r.dossier, "recap") ? el("span", { class: "pastille fluo", texte: "Publié ✓" }) : null,
          el("span", { class: "pastille", texte: `${r.images} images` }),
          r.alertes ? el("span", { class: "pastille rouge", texte: "à vérifier" }) : null))))) : null,
    ladders.length ? sectionClassements(ladders) : null,
    el("section", { class: "section" }, el("h2", { texte: "Les nuits" }),
      el("div", { class: "liste" },
        cartes.length ? cartes : el("p", { class: "aide", texte: "Aucune nuit publiée pour l'instant." }))));
}

/* --- une nuit ---
 * Une nuit peut contenir plusieurs publications : le carrousel du matin, et des
 * posts à part (citations…), repérés par la clé « publication » de chaque image.
 * Chaque publication a son aperçu, sa légende et son bouton « Publier ».
 * Chaque image peut être retirée ou déplacée ; l'ordre de départ est celui du matin. */

const NOMS_PUBLICATION = { carrousel: "Le carrousel", citations: "Les citations", recap: "Le récap",
                           ladders: "Le classement", mercato: "Le mouvement" };
const rangFr = (n) => (Number(n) === 1 ? "1er" : `${n}e`);

/** « Wembanyama 2e · Sarr 9e », ou rien si aucun Français n'est classé. */
function francaisClasses(liste) {
  const famille = (nom) => nom.split(" ").slice(1).join(" ") || nom;
  return (liste || []).map((f) => `${famille(f.nom)} ${rangFr(f.rang)}`).join(" · ");
}

/* --- les classements NBA.com (MVP Ladder, Rookie Ladder) ---
 * Chaque édition est produite ; on en publie une sur deux, ou on attend la suivante. */
function sectionClassements(editions) {
  // l'index note le dossier sans « ladders/ », comme celui des citations
  const chemin = (e) => (e.dossier.startsWith("ladders/") ? e.dossier : `ladders/${e.dossier}`);
  const tous = el("div", { class: "liste cache" });
  const carte = (e) => el("button", {
    class: "carte nuit", onclick: () => (location.hash = `#/production/${encodeURIComponent(chemin(e))}`),
  },
    el("span", { class: "date", texte: e.titre }),
    el("span", { class: "meta", texte: francaisClasses(e.francais) || "Aucun Français classé" }),
    el("span", { class: "pastilles" },
      estPubliee(chemin(e), "ladders") ? el("span", { class: "pastille orange", texte: "Publié ✓" }) : null));
  editions.slice(4).forEach((e) => tous.append(carte(e)));
  return el("section", { class: "section" }, el("h2", { texte: "Les classements" }),
    el("div", { class: "liste" }, editions.slice(0, 4).map(carte)),
    editions.length > 4 ? el("button", { class: "lien", onclick: (ev) => {
      tous.classList.toggle("cache");
      ev.currentTarget.textContent = tous.classList.contains("cache") ? "Éditions précédentes" : "Masquer";
    } }, "Éditions précédentes") : null,
    tous);
}

/* --- le mercato : trades, joueurs coupés, contrats des Français ---
 * Comme pour les citations, l'éditeur pilote : la veille prépare une fiche, on la corrige
 * ici (ou on crée un mouvement de toutes pièces), puis on lance la slide. Une fiche
 * retouchée n'est plus modifiée par la veille, sauf son statut (annonce -> officiel). */
const MERCATO = "mercato.yml";
const TYPES_MVT = {
  trade: "Trade", trade3: "Trade à trois équipes", coupe: "Coupé", rachat: "Racheté (buyout)",
  reclame: "Récupéré après avoir été coupé", signature: "Signature (nouvelle équipe)",
  resignature: "Nouveau contrat (même équipe)", prolongation: "Prolongation",
  conversion: "Contrat standard (fin du two-way)",
};
const FAMILLE_MVT = { trade: "trade", trade3: "trade", coupe: "coupe", rachat: "coupe", reclame: "reclame",
  signature: "contrat", resignature: "contrat", prolongation: "contrat", conversion: "contrat" };
const NATURES_CONTRAT = ["contrat", "prolongation", "contrat two-way", "contrat de 10 jours",
  "jusqu'à la fin de la saison", "contrat standard", "contrat d'essai", "prolongation de contrat rookie"];
const EQUIPES_NBA = { ATL: "Hawks", BOS: "Celtics", BKN: "Nets", CHA: "Hornets", CHI: "Bulls", CLE: "Cavaliers",
  DAL: "Mavericks", DEN: "Nuggets", DET: "Pistons", GSW: "Warriors", HOU: "Rockets", IND: "Pacers",
  LAC: "Clippers", LAL: "Lakers", MEM: "Grizzlies", MIA: "Heat", MIL: "Bucks", MIN: "Timberwolves",
  NOP: "Pelicans", NYK: "Knicks", OKC: "Thunder", ORL: "Magic", PHI: "76ers", PHX: "Suns",
  POR: "Trail Blazers", SAC: "Kings", SAS: "Spurs", TOR: "Raptors", UTA: "Jazz", WAS: "Wizards" };
const POSTES_FR = { PG: "meneur", SG: "arrière", G: "arrière", SF: "ailier", F: "ailier", PF: "ailier fort",
  C: "pivot", "G-F": "arrière-ailier", "F-G": "arrière-ailier", "F-C": "intérieur", "C-F": "intérieur" };
const LISTE_POSTES = ["", "meneur", "arrière", "arrière-ailier", "ailier", "ailier fort", "intérieur", "pivot"];

const sansAccent = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const ecartes = () => lireJSON(CLES.mercatoEcartes, {});
function ecarter(cle, oui) {
  const e = ecartes();
  if (oui) e[cle] = Date.now(); else delete e[cle];
  garder(CLES.mercatoEcartes, JSON.stringify(e));
}

/** L'état d'une fiche en une pastille : à vérifier, slide prête, slide à refaire. */
function pastilleMvt(m) {
  if (m.a_regenerer) return el("span", { class: "pastille orange", texte: "Slide à refaire" });
  if (m.genere) return el("span", { class: "pastille orange", texte: "Slide prête" });
  return el("span", { class: "pastille rouge", texte: "À vérifier" });
}

function carteMvt(m) {
  return el("button", { class: "carte nuit", onclick: () => (location.hash = `#/mercato/${encodeURIComponent(m.cle)}`) },
    el("span", { class: "date", texte: m.titre }),
    el("span", { class: "meta", texte: m.sous_titre }),
    el("span", { class: "pastilles" }, pastilleMvt(m),
      el("span", { class: "pastille", texte: m.statut === "officiel" ? "Officiel" : "Annonce" }),
      m.editee ? el("span", { class: "pastille", texte: "retouchée" }) : null,
      estPubliee(m.dossier, "mercato") ? el("span", { class: "pastille orange", texte: "Publié ✓" }) : null));
}

/** Accueil : les trois derniers mouvements, le reste dans le volet Mercato. */
function sectionMercato(mouvements) {
  const e = ecartes();
  const vus = mouvements.filter((m) => !e[m.cle]);
  if (!vus.length) return null;
  const aVerifier = vus.filter((m) => !m.genere || m.a_regenerer).length;
  return el("section", { class: "section" },
    el("div", { class: "titre-section mini" }, el("h2", { texte: "Le mercato" }),
      el("button", { class: "lien", onclick: () => (location.hash = "#/mercato") },
        aVerifier ? `${aVerifier} à vérifier →` : "Tout voir →")),
    el("div", { class: "liste" }, vus.slice(0, 3).map(carteMvt)));
}

function carteEnCours(titre, texte) {
  return el("div", { class: "carte etat" },
    el("div", { class: "etat-tete" }, el("span", { class: "voyant encours" }), el("strong", { texte: titre })),
    el("p", { class: "aide", texte }));
}

/** La veille lancée à la main : on la suit jusqu'à ce que l'index soit réécrit. */
async function suivreVeilleMercato(zone) {
  const v = lireJSON(CLES.mercatoVeille, null);
  if (!v) return false;
  if (Date.now() - v.depuis > 10 * 60e3) {
    garder(CLES.mercatoVeille, null);
    zone.replaceChildren(el("div", { class: "carte alerte" },
      el("p", { texte: "La veille n'a rien donné après 10 minutes : regarde les derniers lancements dans ⚙." })));
    return false;
  }
  zone.replaceChildren(carteEnCours("Veille en cours…",
    `Lancée à ${heureCourte(new Date(v.depuis).toISOString())}. Compte 1 à 2 minutes : la liste se mettra à jour toute seule.`));
  try {
    const index = await (await contenu("mercato/index.json")).json();
    if (index.verifie_le && new Date(index.verifie_le).getTime() >= v.depuis - 60e3) {
      garder(CLES.mercatoVeille, null);
      const connues = new Set(v.cles || []);
      const neuves = (index.mouvements || []).filter((m) => !connues.has(m.cle)).length;
      toast(neuves ? `Veille terminée : ${pluriel(neuves, "mouvement")}` : "Veille terminée : rien de nouveau");
      return true;
    }
  } catch (x) { /* index pas encore créé : on réessaiera */ }
  return false;
}

/** La slide demandée : on attend qu'elle apparaisse dans l'index, puis on l'ouvre. */
async function suivreGenerationMercato(zone) {
  const g = lireJSON(CLES.mercatoGen, null);
  if (!g) return;
  if (Date.now() - g.depuis > 20 * 60e3) {
    garder(CLES.mercatoGen, null);
    zone.replaceChildren(el("div", { class: "carte alerte" },
      el("p", { texte: "La slide n'est pas arrivée après 20 minutes : regarde les derniers lancements dans ⚙." })));
    return;
  }
  zone.replaceChildren(carteEnCours("Slide en cours…",
    `${g.joueur} · lancée à ${heureCourte(new Date(g.depuis).toISOString())}. Compte 3 à 4 minutes.`));
  try {
    const index = await (await contenu("mercato/index.json")).json();
    const prete = (index.mouvements || []).find((m) => (g.cle ? m.cle === g.cle : m.joueur === g.joueur)
      && m.genere_le && new Date(m.genere_le).getTime() >= g.depuis - 120e3);
    if (prete) {
      garder(CLES.mercatoGen, null);
      toast("C'est prêt !");
      location.hash = `#/production/${encodeURIComponent(prete.dossier)}`;
    }
  } catch (x) { /* index pas encore réécrit : on réessaiera */ }
}

function carteVeilleMercato(verifieLe, cles, zone, recharger) {
  const bouton = el("button", { class: "btn" }, "Lancer une veille");
  bouton.disabled = Boolean(lireJSON(CLES.mercatoVeille, null));
  bouton.addEventListener("click", async () => {
    bouton.disabled = true;
    try {
      await gh(`/repos/${etat.depot}/actions/workflows/${MERCATO}/dispatches`,
        { methode: "POST", corps: { ref: "main", inputs: { mode: "veille" } } });
      garder(CLES.mercatoVeille, JSON.stringify({ depuis: Date.now(), cles }));
      toast("Veille lancée");
      if (await suivreVeilleMercato(zone)) recharger();
    } catch (x) {
      if (x.message !== "401") toast(`Lancement refusé : ${x.message}`);
      bouton.disabled = false;
    }
  });
  return el("div", { class: "carte veille" },
    el("div", {},
      el("p", { class: "r-titre", texte: "Veille des transferts" }),
      el("p", { class: "aide", texte: verifieLe ? `Dernière mise à jour : ${quandCourt(verifieLe)}` : "Pas encore de passage" }),
      el("p", { class: "aide", texte: "Automatique, de plus en plus souvent à l'approche du 11 février." })),
    bouton);
}

async function ecranMercato() {
  clearInterval(etat.minuterie);
  afficher(entete("Mercato", "Chargement…", { retour: true }), el("p", { class: "aide", texte: "Chargement…" }));
  let index = { mouvements: [] };
  try { index = await (await contenu("mercato/index.json")).json(); }
  catch (x) { if (x.message === "401") return; }
  const mouvements = index.mouvements || [];
  const e = ecartes();
  const actifs = mouvements.filter((m) => !e[m.cle]);
  const aVerifier = actifs.filter((m) => !m.genere || m.a_regenerer);
  const prets = actifs.filter((m) => m.genere && !m.a_regenerer);
  const mis = mouvements.filter((m) => e[m.cle]);
  const suivi = el("div", {});
  afficher(
    entete("Mercato", aVerifier.length ? `${aVerifier.length} à vérifier` : "Trades, coupés, contrats des Français", { retour: true }),
    suivi,
    carteVeilleMercato(index.verifie_le, mouvements.map((m) => m.cle), suivi, ecranMercato),
    el("button", { class: "btn", onclick: () => (location.hash = "#/mercato/nouveau") }, "+ Nouveau mouvement"),
    el("section", { class: "section" }, el("h2", { texte: "À vérifier" }),
      aVerifier.length ? el("div", { class: "liste" }, aVerifier.map(carteMvt))
        : el("p", { class: "aide", texte: "Rien à vérifier. Chaque mouvement repéré arrive ici, avec une notification." })),
    prets.length ? el("section", { class: "section" }, el("h2", { texte: "Slides prêtes" }),
      el("div", { class: "liste" }, prets.slice(0, 4).map(carteMvt)),
      prets.length > 4 ? el("details", { class: "plus" }, el("summary", { texte: `${pluriel(prets.length - 4, "mouvement")} plus ancien${prets.length > 5 ? "s" : ""}` }),
        el("div", { class: "liste" }, prets.slice(4).map(carteMvt))) : null) : null,
    mis.length ? el("details", { class: "plus" }, el("summary", { texte: `${pluriel(mis.length, "mouvement")} écarté${mis.length > 1 ? "s" : ""}` }),
      el("div", { class: "liste" }, mis.map(carteMvt))) : null);
  const suivre = async () => {
    if (lireJSON(CLES.mercatoGen, null)) suivreGenerationMercato(suivi);
    else if (await suivreVeilleMercato(suivi)) ecranMercato();
  };
  suivre();
  etat.minuterie = setInterval(suivre, 15000);
}

/* --- l'éditeur d'un mouvement --- */

const champMvt = (titre, ...enfants) => el("div", { class: "m-champ" }, el("label", { class: "r-titre", texte: titre }), ...enfants);

function listeDeroulante(options, valeur, quandChange) {
  const s = el("select", {}, options.map(([v, t]) => el("option", { value: v, texte: t })));
  s.value = valeur ?? "";
  s.addEventListener("change", () => quandChange(s.value));
  return s;
}

function choixEquipe(valeur, quandChange, vide = "Inconnue") {
  const options = [["", vide], ...Object.entries(EQUIPES_NBA).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([c, n]) => [c, `${n} (${c})`])];
  return listeDeroulante(options, valeur || "", (v) => quandChange(v || null));
}

function saisie(type, valeur, attrs, quandChange) {
  const i = el("input", { type, ...attrs });
  i.value = valeur ?? "";
  i.addEventListener("input", () => quandChange(i.value));
  return i;
}

/** Recherche dans la base des joueurs NBA (effectifs ESPN) : pas de faute de nom possible,
 *  et la photo est retrouvée à la génération. */
function chercheurJoueur(quandChoisi, { francaisDabord = false } = {}) {
  const base = etat.baseJoueurs || [];
  const champ = el("input", { type: "search", placeholder: "Tape un nom…", autocomplete: "off", enterkeyhint: "search" });
  const resultats = el("div", { class: "m-resultats" });
  const maj = () => {
    const brut = champ.value.trim().replace(/\s+/g, " ");
    const q = sansAccent(brut);
    const mots = q.split(" ").filter(Boolean);
    const trouves = q.length < 2 ? [] : base.filter((j) => {
      const n = sansAccent(j.nom);
      const parts = n.split(/[\s'.-]+/);
      return mots.every((w) => parts.some((p) => p.startsWith(w)) || n.includes(w));
    }).sort((a, b) => (francaisDabord ? Number(b.fr) - Number(a.fr) : 0) || a.nom.localeCompare(b.nom));
    const items = [];
    if (q.length < 2) {
      items.push(el("p", { class: "aide", texte: base.length
        ? `${base.length} joueurs dans la base. Tape au moins deux lettres.`
        : "La base des joueurs arrive avec la prochaine veille : en attendant, saisis le nom tel quel." }));
    } else {
      items.push(...trouves.slice(0, 8).map((j) => el("button", { class: "m-resultat", onclick: () => quandChoisi(j) },
        el("span", { class: "m-nom", texte: j.nom }),
        el("small", { texte: [j.code ? EQUIPES_NBA[j.code] || j.code : "sans club", POSTES_FR[j.poste]].filter(Boolean).join(" · ") }),
        j.fr ? el("span", { class: "pastille mini-p", texte: "FR" }) : null)));
      if (!trouves.length) items.push(el("p", { class: "aide", texte: "Aucun joueur de la base ne correspond." }));
    }
    if (brut.length >= 3) {
      items.push(el("button", { class: "m-resultat libre", onclick: () => quandChoisi({ nom: brut, espn_id: null, code: "", poste: "" }) },
        el("span", { class: "m-nom", texte: `Utiliser « ${brut} » tel quel` }),
        el("small", { texte: "absent de la base : vérifie l'orthographe, la photo sera cherchée par le nom" })));
    }
    resultats.replaceChildren(...items);
  };
  champ.addEventListener("input", maj);
  champ.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); resultats.querySelector("button")?.click(); }
  });
  maj();
  setTimeout(() => champ.focus(), 0);
  return el("div", { class: "m-chercheur" }, champ, resultats);
}

/** Une contrepartie : joueur, choix de draft, argent ou droits, avec ses réglages. */
function ligneElement(e, i, liste, rendre) {
  const outils = el("div", { class: "m-outils" },
    i > 0 ? el("button", { class: "m-mini", "aria-label": "Monter", onclick: () => {
      [liste[i - 1], liste[i]] = [liste[i], liste[i - 1]]; rendre(); } }, "↑") : null,
    el("button", { class: "m-mini", "aria-label": "Retirer", onclick: () => { liste.splice(i, 1); rendre(); } }, "✕"));
  let corps;
  if (e.genre === "joueur") {
    corps = [el("strong", { texte: e.nom }),
      listeDeroulante(LISTE_POSTES.map((p) => [p, p || "Poste ?"]), LISTE_POSTES.includes(e.poste) ? e.poste : "",
        (v) => { e.poste = v; })];
  } else if (e.genre === "choix") {
    corps = [el("strong", { texte: "Choix de draft" }),
      el("div", { class: "m-choix" },
        el("label", {}, "Tour", listeDeroulante([["1", "1er tour"], ["2", "2e tour"], ["", "Non précisé"]], e.tour == null ? "" : String(e.tour),
          (v) => { e.tour = v ? Number(v) : null; })),
        el("label", {}, "Année", saisie("number", e.annee, { min: "2025", max: "2040", placeholder: "—", inputmode: "numeric" },
          (v) => { e.annee = v ? Number(v) : null; })),
        el("label", {}, "Nombre", saisie("number", e.nombre || 1, { min: "1", max: "9", inputmode: "numeric" },
          (v) => { e.nombre = Math.max(1, Number(v) || 1); }))),
      saisie("text", e.protection, { maxlength: "40", placeholder: "Protection (ex. protégé top 10), facultatif" },
        (v) => { e.protection = v; })];
  } else if (e.genre === "argent") {
    corps = [el("strong", { texte: "Compensation financière" })];
  } else {
    corps = [el("strong", { texte: "Droits sur un joueur pas encore en NBA" }),
      saisie("text", e.nom, { maxlength: "50", placeholder: "Nom du joueur" }, (v) => { e.nom = v; })];
  }
  return el("div", { class: "m-ligne" }, el("div", { class: "m-corps" }, corps), outils);
}

function editeurElements(liste, rendre) {
  const zoneAjout = el("div", {});
  const ajouter = (e) => { liste.push(e); rendre(); };
  return el("div", { class: "m-elements" },
    liste.length ? liste.map((e, i) => ligneElement(e, i, liste, rendre))
      : el("p", { class: "aide", texte: "Rien pour l'instant." }),
    zoneAjout,
    el("div", { class: "pastilles m-ajouts" },
      el("button", { class: "pastille tag", onclick: () => zoneAjout.replaceChildren(
        chercheurJoueur((j) => ajouter({ genre: "joueur", nom: j.nom, espn_id: j.espn_id, poste: POSTES_FR[j.poste] || "" }))) }, "+ Joueur"),
      el("button", { class: "pastille tag", onclick: () => ajouter({ genre: "choix", tour: 2, annee: null, nombre: 1, protection: "" }) }, "+ Choix de draft"),
      el("button", { class: "pastille tag", onclick: () => ajouter({ genre: "argent" }) }, "+ Argent"),
      el("button", { class: "pastille tag", onclick: () => ajouter({ genre: "droits", nom: "" }) }, "+ Droits")));
}

function blocJoueurMvt(m, rendre) {
  const zone = el("div", {});
  const nom = `${m.joueur.prenom || ""} ${m.joueur.nom || ""}`.trim();
  const choisi = (j) => {
    const [prenom, ...reste] = j.nom.split(" ");
    m.joueur = { prenom: reste.length ? prenom : "", nom: reste.length ? reste.join(" ") : prenom, espn_id: j.espn_id || null, nba_id: null };
    // l'équipe actuelle du joueur pré-remplit le départ (ou l'équipe du contrat)
    if (j.code && FAMILLE_MVT[m.type] === "contrat" && !m.vers) m.vers = j.code;
    else if (j.code && FAMILLE_MVT[m.type] !== "contrat" && !m.de) m.de = j.code;
    rendre();
  };
  zone.append(el("div", { class: "m-joueur" },
    el("strong", { texte: nom || "Aucun joueur choisi" }),
    el("button", { class: "lien", onclick: () => zone.replaceChildren(chercheurJoueur(choisi, { francaisDabord: true })) },
      nom ? "Changer" : "Choisir")));
  if (!nom) zone.replaceChildren(chercheurJoueur(choisi, { francaisDabord: true }));
  return zone;
}

function blocColonnes(m, rendre) {
  if (!m.equipes?.length) {
    m.equipes = [{ code: m.vers, recoit: [] }, { code: m.de, recoit: m.contreparties || [] }, { code: null, recoit: [] }];
  }
  return el("div", { class: "m-colonnes" },
    m.equipes.map((c, i) => el("div", { class: "m-colonne" },
      el("div", { class: "r-pied" },
        choixEquipe(c.code, (v) => { c.code = v; rendre(); }, "Équipe ?"),
        el("button", { class: "m-mini", "aria-label": "Retirer l'équipe", onclick: () => { m.equipes.splice(i, 1); rendre(); } }, "✕")),
      c.code && c.code === m.vers ? el("p", { class: "aide", texte: "Équipe d'arrivée : le Français y figure d'office." }) : null,
      el("p", { class: "r-titre", texte: "Reçoit" }),
      editeurElements(c.recoit ||= [], rendre))),
    m.equipes.length < 4 ? el("button", { class: "btn", onclick: () => { m.equipes.push({ code: null, recoit: [] }); rendre(); } }, "+ Équipe") : null);
}

function formulaireMvt(m, rendre) {
  const famille = FAMILLE_MVT[m.type];
  const blocs = [
    el("section", { class: "section carte m-bloc" },
      champMvt("Type de mouvement", listeDeroulante(Object.entries(TYPES_MVT), m.type, (v) => {
        m.type = v;
        // l'équipe déjà connue passe là où ce type de mouvement l'attend
        if (FAMILLE_MVT[v] === "contrat" && !m.vers && m.de) m.vers = m.de;
        if (FAMILLE_MVT[v] === "coupe" && !m.de && m.vers) m.de = m.vers;
        if (FAMILLE_MVT[v] === "contrat" && !m.contrat) m.contrat = { montant: null, annees: null, nature: v === "prolongation" ? "prolongation" : "contrat" };
        if (FAMILLE_MVT[v] === "trade" && m.contreparties === undefined) m.contreparties = [];
        rendre();
      })),
      champMvt("Statut", listeDeroulante([["rumeur", "Annonce (pas encore officiel)"], ["officiel", "Officiel"]], m.statut,
        (v) => { m.statut = v; })),
      champMvt("Source", saisie("text", m.source?.nom, { maxlength: "60", placeholder: "Shams Charania (ESPN)" },
        (v) => { m.source = { ...(m.source || {}), nom: v }; }))),
    el("section", { class: "section carte m-bloc" }, champMvt("Le joueur", blocJoueurMvt(m, rendre))),
  ];
  const equipes = [];
  if (famille === "trade" || famille === "reclame") {
    equipes.push(champMvt(famille === "reclame" ? "Coupé par" : "Équipe de départ", choixEquipe(m.de, (v) => { m.de = v; })),
                 champMvt(famille === "reclame" ? "Récupéré par" : "Équipe d'arrivée", choixEquipe(m.vers, (v) => { m.vers = v; })));
  } else if (famille === "coupe") {
    equipes.push(champMvt("Équipe qui le libère", choixEquipe(m.de, (v) => { m.de = v; })));
  } else {
    equipes.push(champMvt("Équipe", choixEquipe(m.vers, (v) => { m.vers = v; })));
  }
  blocs.push(el("section", { class: "section carte m-bloc" }, equipes));

  if (m.type === "trade") {
    const inconnues = el("input", { type: "checkbox" });
    inconnues.checked = m.contreparties == null;
    inconnues.addEventListener("change", () => {
      if (inconnues.checked) { m._gardees = m.contreparties; m.contreparties = null; }
      else m.contreparties = m._gardees || [];
      rendre();
    });
    blocs.push(el("section", { class: "section carte m-bloc" },
      el("label", { class: "r-titre", texte: `En échange, ${m.de ? `les ${EQUIPES_NBA[m.de]}` : "l'équipe de départ"} reçoivent` }),
      el("label", { class: "m-case" }, inconnues, "Contreparties encore inconnues (« Contreparties à venir » sur la slide)"),
      m.contreparties == null ? null : editeurElements(m.contreparties, rendre)));
  } else if (m.type === "trade3") {
    blocs.push(el("section", { class: "section carte m-bloc" },
      el("label", { class: "r-titre", texte: "Ce que reçoit chaque équipe" }), blocColonnes(m, rendre)));
  } else if (famille === "contrat") {
    m.contrat ||= { montant: null, annees: null, nature: "contrat" };
    const c = m.contrat;
    blocs.push(el("section", { class: "section carte m-bloc" },
      el("div", { class: "m-choix" },
        el("label", {}, "Montant total (M$)", saisie("number", c.montant, { min: "0", step: "0.1", placeholder: "inconnu", inputmode: "decimal" },
          (v) => { c.montant = v ? Number(v) : null; })),
        el("label", {}, "Années", saisie("number", c.annees, { min: "1", max: "7", placeholder: "—", inputmode: "numeric" },
          (v) => { c.annees = v ? Number(v) : null; }))),
      champMvt("Nature du contrat", listeDeroulante(NATURES_CONTRAT.map((n) => [n, n[0].toUpperCase() + n.slice(1)]), c.nature,
        (v) => { c.nature = v; })),
      el("p", { class: "aide", texte: "Sans montant, la slide affiche la nature du contrat (Two-way, 10 jours…)." })));
  }
  if (m.texte) {
    blocs.push(el("details", { class: "carte m-bloc" }, el("summary", { texte: "Texte d'origine" }),
      el("p", { class: "cit-contexte", texte: m.texte }),
      m.source?.url ? el("p", { class: "aide" }, el("a", { href: m.source.url, target: "_blank", rel: "noopener noreferrer", class: "lien" }, "Ouvrir la source")) : null));
  }
  return blocs;
}

async function ecranMouvement(cle) {
  clearInterval(etat.minuterie);
  const nouveau = cle === "nouveau";
  afficher(entete(nouveau ? "Nouveau mouvement" : "Mouvement", "Chargement…", { retour: true }),
    el("p", { class: "aide", texte: "Chargement…" }));
  let fiche = null, entree = null;
  if (!nouveau) {
    try { fiche = await (await contenu(`mercato/${cle}/mouvement.json`)).json(); }
    catch (x) {
      if (x.message === "401") return;
      afficher(entete("Introuvable", null, { retour: true }),
        el("div", { class: "carte alerte" }, el("p", { texte: `Fiche introuvable : ${x.message}` })));
      return;
    }
    try { entree = ((await (await contenu("mercato/index.json")).json()).mouvements || []).find((m) => m.cle === cle) || null; }
    catch (x) { if (x.message === "401") return; }
  }
  if (!etat.baseJoueurs?.length) {
    try { etat.baseJoueurs = (await (await contenu("mercato/joueurs.json")).json()).joueurs || []; }
    catch (x) { if (x.message === "401") return; etat.baseJoueurs = []; }
  }
  const m = fiche ? structuredClone(fiche) : {
    cle: "", type: "trade", statut: "rumeur", joueur: { prenom: "", nom: "" }, de: null, vers: null,
    contreparties: [], source: { nom: "Shams Charania (ESPN)", url: "" }, date: new Date().toISOString(),
  };
  if (!nouveau) m.cle = cle;

  const suivi = el("div", {});
  const zone = el("div", {});
  const rendre = () => zone.replaceChildren(...formulaireMvt(m, rendre));
  rendre();

  const bouton = el("button", { class: "btn principal" }, entree?.genere ? "Refaire la slide" : "Générer la slide");
  const majBouton = () => { bouton.disabled = Boolean(lireJSON(CLES.mercatoGen, null)); };
  bouton.addEventListener("click", async () => {
    if (!m.joueur?.nom) { toast("Choisis d'abord le joueur."); return; }
    const envoi = { ...m };
    delete envoi._gardees;
    const texte = JSON.stringify(envoi);
    if (texte.length > 60000) { toast("Fiche trop longue : retire quelques éléments."); return; }
    bouton.disabled = true;
    try {
      await gh(`/repos/${etat.depot}/actions/workflows/${MERCATO}/dispatches`,
        { methode: "POST", corps: { ref: "main", inputs: { mode: "generer", fiche: texte } } });
      garder(CLES.mercatoGen, JSON.stringify({ cle: m.cle || "", joueur: `${m.joueur.prenom} ${m.joueur.nom}`.trim(), depuis: Date.now() }));
      toast("Slide lancée");
      window.scrollTo(0, 0);                       // le suivi s'affiche en haut de la fiche
      suivreGenerationMercato(suivi);
    } catch (x) {
      if (x.message !== "401") toast(`Lancement refusé : ${x.message}`);
      majBouton();
    }
  });
  majBouton();

  const estEcarte = !nouveau && Boolean(ecartes()[cle]);
  afficher(
    entete(nouveau ? "Nouveau mouvement" : (entree?.titre || "Mouvement"), entree?.sous_titre || "Tout se règle ici avant la slide", { retour: true }),
    suivi,
    entree ? el("div", { class: "pastilles m-etat" }, pastilleMvt(entree),
      entree.editee ? el("span", { class: "pastille", texte: "retouchée" }) : null) : null,
    entree?.a_regenerer ? el("div", { class: "carte alerte-orange" },
      el("p", { texte: entree.a_regenerer === "officiel"
        ? "C'est devenu officiel depuis la slide : refais-la pour avoir le badge « Officiel »."
        : "La veille a reçu des précisions depuis la slide : vérifie la fiche puis refais-la." })) : null,
    entree?.genere ? el("button", { class: "btn", onclick: () => (location.hash = `#/production/${encodeURIComponent(entree.dossier)}`) },
      "Voir la slide et la légende") : null,
    zone,
    nouveau ? null : el("button", { class: "lien m-ecarter", onclick: () => {
      ecarter(cle, !estEcarte); toast(estEcarte ? "Remis dans la liste" : "Écarté de la liste"); history.back(); } },
      estEcarte ? "Remettre ce mouvement dans la liste" : "Écarter ce mouvement (fausse piste, sans intérêt…)"),
    el("div", { class: "barre" }, bouton));
  suivreGenerationMercato(suivi);
  etat.minuterie = setInterval(() => { suivreGenerationMercato(suivi); majBouton(); }, 15000);
}
const pubDe =(im) => im.publication || etat.fiche?.publication || "carrousel";
const nomPublication = (pub) => NOMS_PUBLICATION[pub] || pub;
const image = (fichier) => etat.fiche.images.find((im) => im.fichier === fichier);

function publications() {
  return [...new Set(etat.fiche.images.map(pubDe))];
}

/** Les images d'une publication dans l'ordre courant, sauf celles écartées par un choix. */
function visibles(pub) {
  return etat.ordre[pub].map(image)
    .filter((im) => !(im.facultative && im.choix && etat.choix[im.choix] === false));
}

/** Ce qui sera publié : les visibles, moins celles retirées à la main. */
function selection(pub) {
  return visibles(pub).filter((im) => !etat.retirees.has(im.fichier));
}

function pubDuChoix(c) {
  const im = etat.fiche.images.find((i) => i.choix === c.id);
  return im ? pubDe(im) : "carrousel";
}

function cleLegende(pub) {
  const f = etat.fiche;
  for (const c of f.choix) {
    if (pubDuChoix(c) === pub && etat.choix[c.id] && c.legende && f.legendes[c.legende]) return c.legende;
  }
  return pub === "carrousel" || !f.legendes[pub] ? "base" : pub;
}

/** La légende brute du matin pour la combinaison de choix et le ton retenus. */
function legendeBrute(pub) {
  const f = etat.fiche, cle = cleLegende(pub);
  if (etat.ton[pub] === "passionne" && f.legendes[`${cle}_passionne`]) return f.legendes[`${cle}_passionne`];
  return f.legendes[cle] || "";
}

/** Sépare le dernier paragraphe s'il n'est fait que de hashtags. */
function decouper(texte) {
  const paras = texte.replace(/\s+$/, "").split(/\n\s*\n/);
  const dernier = paras[paras.length - 1] || "";
  const mots = dernier.trim().split(/\s+/);
  if (paras.length > 1 && mots.length && mots.every((m) => m.startsWith("#"))) {
    return { corps: paras.slice(0, -1).join("\n\n"), tags: mots };
  }
  return { corps: texte.replace(/\s+$/, ""), tags: [] };
}

function legendeCourante(pub) {
  const { corps, tags } = decouper(legendeBrute(pub));
  const gardes = tags.filter((t) => !etat.tagsRetires[pub]?.has(t));
  return gardes.length ? `${corps}\n\n${gardes.join(" ")}` : corps;
}

/** Remet la légende à jour dans la zone de texte, sauf si elle a été retouchée à la main. */
function rafraichirLegende(pub) {
  const zone = document.getElementById(`legende-${pub}`);
  if (!zone) return;
  if (!etat.legendeModifiee[pub]) zone.value = legendeCourante(pub);
  else toast("Légende modifiée à la main : pensez à la relire.");
}

function deplacer(pub, fichier, sens) {
  const vis = visibles(pub).map((im) => im.fichier);
  const i = vis.indexOf(fichier), j = i + sens;
  if (i < 0 || j < 0 || j >= vis.length) return;
  const ordre = etat.ordre[pub];
  const a = ordre.indexOf(vis[i]), b = ordre.indexOf(vis[j]);
  [ordre[a], ordre[b]] = [ordre[b], ordre[a]];
  majApercu();
}

function basculerRetrait(fichier) {
  if (etat.retirees.has(fichier)) etat.retirees.delete(fichier); else etat.retirees.add(fichier);
  majApercu();
}

function vignette(pub, im, rang, total, premiere, derniere) {
  const url = etat.urls[im.fichier];
  const retiree = etat.retirees.has(im.fichier);
  return el("figure", { class: `vignette${im.facultative ? " facultative" : ""}${retiree ? " retiree" : ""}` },
    url ? el("img", { src: url, alt: im.titre }) : el("div", { class: "vide", texte: "Chargement…" }),
    el("figcaption", { class: "rang", texte: retiree ? `retirée · ${im.titre}` : `${rang}/${total} · ${im.titre}` }),
    el("div", { class: "commandes" },
      el("button", { "aria-label": "Avancer", disabled: premiere, onclick: () => deplacer(pub, im.fichier, -1) }, "◀"),
      el("button", { class: "retrait", onclick: () => basculerRetrait(im.fichier) }, retiree ? "Remettre" : "Retirer"),
      el("button", { "aria-label": "Reculer", disabled: derniere, onclick: () => deplacer(pub, im.fichier, 1) }, "▶")));
}

function majApercu() {
  for (const pub of publications()) {
    const zone = document.getElementById(`apercu-${pub}`);
    if (!zone) continue;
    const vis = visibles(pub);
    const total = selection(pub).length;
    let rang = 0;
    zone.replaceChildren(...(vis.length
      ? vis.map((im, i) => vignette(pub, im, etat.retirees.has(im.fichier) ? 0 : ++rang, total,
                                    i === 0, i === vis.length - 1))
      : [el("p", { class: "aide", texte: "Rien de retenu : rien à publier." })]));
    document.getElementById(`compte-${pub}`).textContent =
      `${nomPublication(pub)} · ${total} image${total > 1 ? "s" : ""}`;
    const bouton = document.getElementById(`publier-${pub}`);
    if (bouton) bouton.disabled = !total;
    const retablir = document.getElementById(`retablir-${pub}`);
    if (retablir) {
      const modifie = etat.ordre[pub].some((f, i) => f !== etat.ordreInitial[pub][i])
        || etat.ordre[pub].some((f) => etat.retirees.has(f));
      retablir.classList.toggle("cache", !modifie);
    }
  }
}

function carteChoix(c) {
  const garde = el("button", { class: "garder", "aria-pressed": String(etat.choix[c.id]) }, "Garder");
  const retire = el("button", { "aria-pressed": String(!etat.choix[c.id]) }, "Retirer");
  const basculer = (valeur) => {
    etat.choix[c.id] = valeur;
    garde.setAttribute("aria-pressed", String(valeur));
    retire.setAttribute("aria-pressed", String(!valeur));
    majApercu();
    rafraichirLegende(pubDuChoix(c));
  };
  garde.addEventListener("click", () => basculer(true));
  retire.addEventListener("click", () => basculer(false));
  const conseil = c.suggestion === "garder" ? "Suggestion : garder." : c.suggestion === "retirer" ? "Suggestion : retirer." : null;
  return el("div", { class: "carte choix" },
    el("div", { class: "titre", texte: c.titre }),
    el("p", { class: "phrase", texte: c.phrase }),
    conseil ? el("p", { class: "aide", texte: c.raison ? `${conseil} ${c.raison}` : conseil }) : null,
    c.source ? el("p", { class: "aide", texte: `Source : ${c.source}` }) : null,
    el("div", { class: "bascule", role: "group", "aria-label": c.titre }, garde, retire),
    c.autres && c.autres.length
      ? el("details", {}, el("summary", { texte: "Autres faits repérés cette nuit" }),
          el("ul", {}, c.autres.map((a) => el("li", { texte: a }))))
      : null);
}

async function chargerImages(nuit) {
  const file = [...etat.fiche.images];
  const ouvrier = async () => {
    while (file.length) {
      const im = file.shift();
      try {
        const blob = await (await contenu(`${nuit}/${im.fichier}`)).blob();
        if (etat.fiche?.nuit !== nuit) return;          // on a changé d'écran entre-temps
        etat.fichiers[im.fichier] = blob;
        etat.urls[im.fichier] = URL.createObjectURL(blob);
        majApercu();
      } catch (x) {
        if (x.message === "401") return;
        toast(`Image ${im.fichier} introuvable`);
      }
    }
  };
  await Promise.all([ouvrier(), ouvrier(), ouvrier()]);
}

/** Les images retenues d'une publication, renumérotées dans l'ordre : 01.png, 02.png… */
function fichiersDe(pub) {
  return selection(pub).map((im, i) => new File([etat.fichiers[im.fichier]],
    `${String(i + 1).padStart(2, "0")}.png`, { type: "image/png" }));
}

function majMarquePublication(pub) {
  const marque = document.getElementById(`publiee-${pub}`);
  if (!marque) return;
  const oui = estPubliee(etat.fiche.nuit, pub);
  marque.textContent = oui ? "Publiée ✓ · annuler" : "Marquer comme publiée";
  marque.classList.toggle("fait", oui);
}

async function publier(pub) {
  const sel = selection(pub);
  if (!sel.length) return;
  if (sel.some((im) => !etat.fichiers[im.fichier])) { toast("Images encore en chargement…"); return; }
  const fichiers = fichiersDe(pub);
  let copiee = false;
  try { await navigator.clipboard.writeText(document.getElementById(`legende-${pub}`).value); copiee = true; } catch { /* refusé */ }
  if (navigator.canShare && navigator.canShare({ files: fichiers })) {
    try {
      await navigator.share({ files: fichiers });
      marquerPubliee(etat.fiche.nuit, pub, true);
      majMarquePublication(pub);
      toast(copiee ? "Légende copiée : collez-la dans Instagram." : "Pensez à copier la légende.");
    } catch (x) {
      if (x.name !== "AbortError") toast(`Partage impossible : ${x.message}`);
    }
  } else {
    enregistrer(fichiers);
    toast(copiee ? "Images enregistrées, légende copiée." : "Images enregistrées.");
  }
}

function enregistrer(fichiers) {
  for (const f of fichiers) {
    const a = el("a", { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a); a.click(); a.remove();
  }
}

function choixDuTon(pub) {
  const f = etat.fiche;
  if (!f.legendes[`${cleLegende(pub)}_passionne`] && !f.legendes.base_passionne) return null;
  const boutons = [["factuel", "Factuel"], ["passionne", "Passionné"]].map(([ton, nom]) =>
    el("button", { "aria-pressed": String((etat.ton[pub] || "factuel") === ton), onclick: (e) => {
      etat.ton[pub] = ton;
      e.currentTarget.parentElement.querySelectorAll("button")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)));
      etat.legendeModifiee[pub] = false;          // changer de ton repart du texte du matin
      rafraichirLegende(pub);
    } }, nom));
  return el("div", { class: "bascule ton", role: "group", "aria-label": "Ton de la légende" }, boutons);
}

function pastillesHashtags(pub, zone) {
  const { tags } = decouper(legendeBrute(pub));
  if (!tags.length) return null;
  etat.tagsRetires[pub] ||= new Set();
  return el("details", { class: "hashtags" },
    el("summary", { texte: `Hashtags (${tags.length}) : touche pour retirer ou remettre` }),
    el("div", { class: "pastilles" }, tags.map((t) => el("button", {
      class: `pastille tag${etat.tagsRetires[pub].has(t) ? " off" : ""}`,
      onclick: (e) => {
        const retires = etat.tagsRetires[pub];
        if (retires.has(t)) retires.delete(t); else retires.add(t);
        e.currentTarget.classList.toggle("off", retires.has(t));
        // on ne touche qu'au paragraphe des hashtags : une retouche du texte est conservée
        const { corps } = decouper(zone.value);
        const gardes = decouper(legendeBrute(pub)).tags.filter((x) => !retires.has(x));
        zone.value = gardes.length ? `${corps}\n\n${gardes.join(" ")}` : corps;
      },
    }, t))));
}

function sectionPublication(pub) {
  const legende = el("textarea", { id: `legende-${pub}`, spellcheck: "true",
                                   oninput: () => (etat.legendeModifiee[pub] = true) });
  legende.value = legendeCourante(pub);
  const marque = el("button", { class: "lien-publiee", id: `publiee-${pub}`, onclick: () => {
    marquerPubliee(etat.fiche.nuit, pub, !estPubliee(etat.fiche.nuit, pub));
    majMarquePublication(pub);
  } });
  const section = el("section", { class: "section" },
    el("div", { class: "titre-section" },
      el("h2", { id: `compte-${pub}` }),
      el("button", { class: "lien cache", id: `retablir-${pub}`, onclick: () => {
        etat.ordre[pub] = [...etat.ordreInitial[pub]];
        etat.ordre[pub].forEach((f) => etat.retirees.delete(f));
        majApercu();
      } }, "Rétablir")),
    el("div", { class: "defile", id: `apercu-${pub}` }),
    el("h2", { texte: "La légende", class: "sous-titre" }),
    choixDuTon(pub), legende, pastillesHashtags(pub, legende),
    el("div", { class: "rangee" },
      el("button", { class: "btn", onclick: async () => {
        try { await navigator.clipboard.writeText(legende.value); toast("Légende copiée."); }
        catch { legende.select(); toast("Copie refusée : sélectionnez le texte à la main."); }
      } }, "Copier la légende"),
      el("button", { class: "btn", onclick: () => enregistrer(fichiersDe(pub)) }, "Enregistrer")),
    el("button", { class: "btn principal publier", id: `publier-${pub}`, onclick: () => publier(pub) },
      publications().length > 1 ? `Publier ${nomPublication(pub).toLowerCase()}` : "Publier sur Instagram"),
    marque);
  return section;
}

async function ecranNuit(nuit) {
  const tete = entete("Chargement…", null, { retour: true });
  afficher(tete, el("p", { class: "aide", texte: "Chargement de la nuit…" }));
  let fiche;
  try {
    fiche = await (await contenu(`${nuit}/manifeste.json`)).json();
  } catch (x) {
    if (x.message === "401") return;
    afficher(entete("Introuvable", null, { retour: true }),
      el("div", { class: "carte alerte" }, el("p", { texte: `Contenu introuvable : ${x.message}` })));
    return;
  }
  Object.values(etat.urls).forEach((u) => URL.revokeObjectURL(u));
  fiche.nuit = fiche.nuit || nuit;                  // une production n'a pas de date de nuit
  etat.fiche = fiche; etat.fichiers = {}; etat.urls = {}; etat.legendeModifiee = {};
  etat.choix = Object.fromEntries(fiche.choix.map((c) => [c.id, c.defaut !== false]));
  etat.retirees = new Set(); etat.ton = {}; etat.tagsRetires = {};
  etat.ordre = {}; etat.ordreInitial = {};
  for (const pub of publications()) {
    etat.ordreInitial[pub] = fiche.images.filter((im) => pubDe(im) === pub).map((im) => im.fichier);
    etat.ordre[pub] = [...etat.ordreInitial[pub]];
  }

  afficher(
    entete(fiche.date_fr || fiche.titre || fiche.nuit,
           resumeTexte(fiche.resume)
             || (fiche.publication === "ladders" ? francaisClasses(fiche.francais) || "Aucun Français classé" : "")
             || (fiche.publication === "mercato" ? fiche.sous_titre : "")
             || FORMATS[fiche.format] || "", { retour: true }),
    fiche.source && fiche.publication === "ladders"
      ? el("p", { class: "aide" }, "Source : ",
          el("a", { href: fiche.source, target: "_blank", rel: "noopener noreferrer", texte: "NBA.com" }),
          " — publier une édition sur deux suffit.")
      : null,
    fiche.publication === "mercato" && fiche.lien
      ? el("p", { class: "aide" }, "Source : ",
          el("a", { href: fiche.lien, target: "_blank", rel: "noopener noreferrer", texte: fiche.nom_source || "ESPN" }))
      : null,
    fiche.alertes.length
      ? el("div", { class: "carte alerte" }, el("p", { texte: "À vérifier avant de publier :" }),
          fiche.alertes.map((a) => el("p", { texte: `• ${a}` })))
      : null,
    fiche.choix.length
      ? el("section", { class: "section" }, el("h2", { texte: "Tes choix" }),
          el("div", { class: "liste" }, fiche.choix.map(carteChoix)))
      : null,
    publications().map(sectionPublication),
    (fiche.videos || []).map((v) => sectionVideo(nuit, v)));
  publications().forEach(majMarquePublication);
  majApercu();
  chargerImages(nuit);
}

/* --- le Reel du matin : la vidéo verticale du carrousel, publiée à part ---
 * manifeste.json : « videos » = [{fichier, couverture, publication, titre, legende, conseil}].
 * Même légende que le carrousel ; publication par le partage Android (fichier mp4). */
function sectionVideo(nuit, v) {
  const pub = v.publication || "reel";
  const lecteur = el("video", { class: "reel-video", controls: true, playsinline: true, preload: "metadata" });
  const etatVideo = el("p", { class: "aide", texte: "Chargement de la vidéo…" });
  const legende = el("textarea", { id: `legende-${pub}`, spellcheck: "true" });
  legende.value = etat.fiche.legendes[v.legende || "base"] || legendeCourante("carrousel");
  let fichier = null;
  const marque = el("button", { class: "lien-publiee" });
  const majMarque = () => {
    const oui = estPubliee(nuit, pub);
    marque.textContent = oui ? "Publié ✓ · annuler" : "Marquer comme publié";
    marque.classList.toggle("fait", oui);
  };
  marque.addEventListener("click", () => { marquerPubliee(nuit, pub, !estPubliee(nuit, pub)); majMarque(); });
  majMarque();

  // la vidéo et sa couverture se lisent comme les images : API GitHub, puis adresse locale
  (async () => {
    try {
      const [video, couverture] = await Promise.all([
        contenu(`${nuit}/${v.fichier}`).then((r) => r.blob()),
        v.couverture ? contenu(`${nuit}/${v.couverture}`).then((r) => r.blob()).catch(() => null) : null]);
      if (etat.fiche?.nuit !== nuit) return;                 // on a changé d'écran entre-temps
      fichier = new File([video], v.fichier.split("/").pop(), { type: "video/mp4" });
      etat.urls[v.fichier] = URL.createObjectURL(fichier);
      if (couverture) { etat.urls[v.couverture] = URL.createObjectURL(couverture); lecteur.poster = etat.urls[v.couverture]; }
      lecteur.src = etat.urls[v.fichier];
      etatVideo.textContent = `${(video.size / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
    } catch (x) {
      if (x.message !== "401") etatVideo.textContent = `Vidéo introuvable : ${x.message}`;
    }
  })();

  const publierVideo = async () => {
    if (!fichier) { toast("Vidéo encore en chargement…"); return; }
    let copiee = false;
    try { await navigator.clipboard.writeText(legende.value); copiee = true; } catch { /* refusé */ }
    if (navigator.canShare && navigator.canShare({ files: [fichier] })) {
      try {
        await navigator.share({ files: [fichier] });
        marquerPubliee(nuit, pub, true);
        majMarque();
        toast(copiee ? "Légende copiée : collez-la dans Instagram." : "Pensez à copier la légende.");
      } catch (x) {
        if (x.name !== "AbortError") toast(`Partage impossible : ${x.message}`);
      }
    } else {
      enregistrer([fichier]);
      toast(copiee ? "Vidéo enregistrée, légende copiée." : "Vidéo enregistrée.");
    }
  };

  return el("section", { class: "section" },
    el("h2", { texte: v.titre || "Le Reel" }),
    el("div", { class: "reel-cadre" }, lecteur),
    etatVideo,
    v.conseil ? el("div", { class: "carte alerte-orange" }, el("p", { texte: `Conseil : ${v.conseil}.` })) : null,
    el("h2", { texte: "La légende", class: "sous-titre" }),
    legende,
    el("div", { class: "rangee" },
      el("button", { class: "btn", onclick: () => {
        const zone = document.getElementById("legende-carrousel");
        legende.value = zone ? zone.value : legendeCourante("carrousel");
        toast("Légende du carrousel reprise.");
      } }, "Reprendre celle du carrousel"),
      el("button", { class: "btn", onclick: async () => {
        try { await navigator.clipboard.writeText(legende.value); toast("Légende copiée."); }
        catch { legende.select(); toast("Copie refusée : sélectionnez le texte à la main."); }
      } }, "Copier la légende")),
    el("button", { class: "btn principal publier", onclick: publierVideo }, "Publier le Reel"),
    marque);
}

/* --- les Bleus : la saison, les records, l'histoire --- */

const nombre = (x) => Number(x).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const jjmm = (iso) => { const [a, m, j] = iso.split("-"); return `${j}/${m}/${a}`; };

function ligneJoueur(j) {
  const max = Math.max(1, ...j.derniers.map((d) => d.pts));
  return el("details", { class: "carte joueur" },
    el("summary", {},
      el("span", { class: "j-nom" }, j.nom, el("em", { texte: `${j.equipe} · ${j.matchs} match${j.matchs > 1 ? "s" : ""} · ${nombre(j.min)} min` })),
      el("span", { class: "j-moy" }, el("b", { texte: nombre(j.pts) }), " pts")),
    el("p", { class: "aide", texte: `${nombre(j.reb)} rebonds · ${nombre(j.ast)} passes · ${nombre(j.blk)} contres · ${nombre(j.stl)} interceptions · ${nombre(j.fg3m)} à 3 pts` }),
    el("div", { class: "mini" }, j.derniers.map((d) => el("div", { class: "mini-col" },
      el("span", { texte: d.pts }), el("i", { style: null, "data-h": Math.max(4, Math.round(d.pts / max * 56)) }),
      el("small", { texte: d.adversaire })))),
    el("p", { class: "aide", texte: "Records en carrière : " + ["pts", "reb", "ast", "blk"].map((c) => {
      const r = j.records_carriere[c];
      return `${r.valeur} ${{ pts: "pts", reb: "reb", ast: "pd", blk: "ctr" }[c]} (${jjmm(r.date)} vs ${r.adversaire})`;
    }).join(" · ") }));
}

async function ecranBleus() {
  const tete = entete("Les Bleus", "Chargement…", { retour: true });
  afficher(tete, el("p", { class: "aide", texte: "Chargement…" }));
  let f;
  try {
    f = await (await contenu("bleus.json")).json();
  } catch (x) {
    if (x.message === "401") return;
    afficher(tete, el("div", { class: "carte alerte" }, el("p", { texte: "La fiche des Bleus arrivera avec le prochain carrousel du matin." })));
    return;
  }
  afficher(
    entete("Les Bleus", `Saison ${f.saison} · au ${jjmm(f.jusqua)}`, { retour: true }),
    el("section", { class: "section" }, el("h2", { texte: "La saison, par points" }),
      el("div", { class: "liste" }, f.joueurs.map(ligneJoueur))),
    f.records_saison.length ? el("section", { class: "section" }, el("h2", { texte: "Records français de la saison" }),
      el("div", { class: "carte" }, f.records_saison.map((r) => el("div", { class: "lancement" },
        el("span", {}, el("b", { texte: `${r.valeur} ${r.stat}` }), ` · ${r.joueur}`),
        el("span", { class: "aide", texte: `${jjmm(r.date)} vs ${r.adversaire}` }))))) : null,
    el("section", { class: "section" }, el("h2", { texte: "Meilleurs marqueurs français de l'histoire" }),
      el("div", { class: "carte" }, f.marqueurs.map((m, i) => el("div", { class: "lancement" },
        el("span", {}, `${i + 1}. `, el("b", { class: m.actif ? "ok" : null, texte: m.joueur }), m.actif ? " · en activité" : ""),
        el("span", { texte: `${nombre(m.pts)} pts · ${nombre(m.matchs)} m.` }))))),
    f.demain && f.demain.length ? el("section", { class: "section" }, el("h2", { texte: "La nuit prochaine" }),
      el("div", { class: "pastilles" }, f.demain.map((d) => el("span", { class: "pastille", texte: d })))) : null,
    el("p", { class: "aide note", texte: f.note }));
  // hauteurs des mini-barres posées après coup : la politique de sécurité interdit les styles en ligne
  document.querySelectorAll(".mini i[data-h]").forEach((i) => { i.style.height = `${i.dataset.h}px`; });
}

/* --- citations : la veille propose, on choisit, GitHub met en forme --- */

const FORMATS = { statement: "Citation seule", joueur: "Carrousel même joueur", mix: "Carrousel plusieurs Français" };
const MOMENTS = { apres: "Après le match", avant: "Avant le match", entrainement: "À l'entraînement" };
const TEXTE_MAX = 400, CONTEXTE_MAX = 220;

/** Ce qui part au moteur : seulement ce qui diffère de la détection automatique. */
function optionsDe(c) {
  const o = etat.citOpt[c.id] || {};
  const sortie = {};
  if (o.texte != null && o.texte.trim() && o.texte.trim() !== c.citation) sortie.texte = o.texte.trim().slice(0, TEXTE_MAX);
  if (o.contexte && o.contexte.trim()) sortie.contexte = o.contexte.trim().slice(0, CONTEXTE_MAX);
  if (o.moment && o.moment !== "auto") sortie.moment = o.moment;
  return sortie;
}

function reglagesCitation(c) {
  const o = (etat.citOpt[c.id] ||= { texte: c.citation, contexte: "", moment: "auto" });
  const compte = (zone, max, sortie) => () => { sortie.textContent = `${zone.value.length}/${max}`;
    sortie.classList.toggle("trop", zone.value.length > max); };

  // le texte de la slide
  const texte = el("textarea", { class: "court", maxlength: String(TEXTE_MAX) });
  texte.value = o.texte;
  const compteTexte = el("small", { class: "compteur" });
  const majTexte = compte(texte, TEXTE_MAX, compteTexte);
  texte.addEventListener("input", () => { o.texte = texte.value; majTexte(); });
  majTexte();
  const boutonsTexte = el("div", { class: "rangee petite" },
    el("button", { class: "btn", onclick: () => { texte.value = c.citation; o.texte = c.citation; majTexte(); } }, "Extrait court"),
    c.complete && c.complete !== c.citation
      ? el("button", { class: "btn", onclick: () => { texte.value = c.complete.slice(0, TEXTE_MAX); o.texte = texte.value; majTexte();
          if (c.complete.length > TEXTE_MAX) toast(`Propos coupé à ${TEXTE_MAX} caractères : à retoucher.`); } }, "Propos complet")
      : null);

  // la phrase de contexte : une proposition ou un texte libre
  const contexte = el("input", { type: "text", maxlength: String(CONTEXTE_MAX), placeholder: "Aucune phrase de contexte" });
  contexte.value = o.contexte;
  const compteCtx = el("small", { class: "compteur" });
  const majCtx = compte(contexte, CONTEXTE_MAX, compteCtx);
  contexte.addEventListener("input", () => { o.contexte = contexte.value; majCtx(); });
  majCtx();
  const propositions = (c.contextes_proposes || []).filter(Boolean);

  // le moment du propos
  const moment = el("select", {},
    [["auto", `Automatique${c.match?.moment ? ` (${MOMENTS[c.match.moment] || c.match.moment})` : " (aucun)"}`],
     ["apres", "Après le match"], ["avant", "Avant le match"], ["entrainement", "À l'entraînement"],
     ["aucun", "Pas de bandeau"]].map(([v, t]) => el("option", { value: v, texte: t })));
  moment.value = o.moment;
  moment.addEventListener("change", () => { o.moment = moment.value; });

  return el("div", { class: "reglages" },
    el("label", { class: "r-titre", texte: "Texte de la slide" }), texte,
    el("div", { class: "r-pied" }, boutonsTexte, compteTexte),
    el("label", { class: "r-titre", texte: "Phrase de contexte (à droite du guillemet)" }),
    propositions.length ? el("div", { class: "pastilles" },
      el("button", { class: "pastille tag off", onclick: () => { contexte.value = ""; o.contexte = ""; majCtx(); } }, "Aucune"),
      propositions.map((p) => el("button", { class: "pastille tag", title: p,
        onclick: () => { contexte.value = p.slice(0, CONTEXTE_MAX); o.contexte = contexte.value; majCtx(); } },
        p.length > 60 ? `${p.slice(0, 58)}…` : p))) : null,
    contexte, el("div", { class: "r-pied" }, el("span"), compteCtx),
    el("label", { class: "r-titre", texte: "Moment du propos" }), moment);
}
/** Le dossier d'une production, depuis la racine de la branche (l'index le note sans « citations/ »). */
const cheminProduction = (p) => (p.dossier.startsWith("citations/") ? p.dossier : `citations/${p.dossier}`);

/** Même règle que le moteur : 1 citation, un seul joueur, ou plusieurs Français. */
function formatPour(choisies) {
  if (!choisies.length) return null;
  if (choisies.length === 1) return "statement";
  return new Set(choisies.map((c) => c.espn_id)).size === 1 ? "joueur" : "mix";
}

/** « 12 novembre à 14:36 » : le format de date unique des citations, sans jour de la semaine. */
const quandCourt = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })} à ${heureCourte(iso)}`;
};

function carteCandidat(c, majBarre) {
  const coche = el("input", { type: "checkbox", id: `c-${c.id}` });
  coche.checked = etat.citSel.has(c.id);
  const zoneReglages = el("div", {});
  const majReglages = () => zoneReglages.replaceChildren(...(coche.checked ? [reglagesCitation(c)] : []));
  coche.addEventListener("change", () => {
    if (coche.checked) etat.citSel.add(c.id); else etat.citSel.delete(c.id);
    carte.classList.toggle("choisie", coche.checked);
    majReglages();
    majBarre();
  });
  const m = c.match;
  const lireArticle = (c.article || []).length
    ? el("details", {}, el("summary", { texte: "Lire plus de l'article" }),
        el("div", { class: "article" }, c.article.map((p, i) =>
          el("p", { class: i === c.article_position ? "cite" : null, texte: p }))),
        el("p", { class: "aide" }, el("a", { href: c.lien, target: "_blank", rel: "noopener noreferrer" }, "Ouvrir l'article complet")))
    : null;
  const qui = c.relation && c.relation !== "de" ? `${c.orateur} · ${c.relation}` : c.orateur;
  const carte = el("div", { class: `carte citation${coche.checked ? " choisie" : ""}` },
    el("p", { class: "cit-date" }, c.publiee ? quandCourt(c.publiee) : "Date inconnue",
      (c.sources || []).length ? el("span", { texte: ` · ${c.sources.join(", ")}` }) : null),
    el("label", { for: `c-${c.id}`, class: "cit-tete" }, coche,
      el("span", { class: "cit-texte", texte: `« ${c.citation} »` })),
    el("p", { class: "cit-qui", texte: qui }),
    m ? el("p", { class: "aide" }, m.contexte_fr || MOMENTS[m.moment] || "",
          m.moment_source === "heure" ? el("span", { class: "pastille rouge mini-p", texte: "moment à vérifier" }) : null) : null,
    el("div", { class: "pastilles" },
      el("span", { class: `pastille${c.suggestion === "garder" ? " fluo" : ""}`,
                   texte: c.suggestion === "garder" ? "Suggestion : garder" : "Suggestion : retirer" }),
      c.deja_produite ? el("span", { class: "pastille", texte: "déjà produite" }) : null,
      c.langue && c.langue !== "fr" ? el("span", { class: "pastille", texte: c.langue === "en" ? "en anglais" : `en ${c.langue}` }) : null),
    c.raison ? el("p", { class: "aide", texte: c.raison }) : null,
    (c.a_verifier || []).length ? el("p", { class: "erreur", texte: `À vérifier : ${c.a_verifier.join(" · ")}` }) : null,
    lireArticle,
    el("details", {}, el("summary", { texte: lireArticle ? "Le passage et la source" : "Lire le passage" }),
      c.question ? el("p", { class: "aide", texte: `Question : ${c.question}` }) : null,
      el("p", { class: "cit-contexte", texte: c.contexte || c.complete || c.citation }),
      el("p", { class: "aide" }, `${(c.sources || []).join(", ")}${c.publiee ? ` · ${quandCourt(c.publiee)}` : ""} · `,
        el("a", { href: c.lien, target: "_blank", rel: "noopener noreferrer" }, "l'article"))),
    zoneReglages);
  majReglages();
  return carte;
}

/** Les sources que la dernière veille n'a pas pu lire : la liste peut être incomplète. */
function bandeauSources(sources) {
  if (!sources.length) return null;
  const enPanne = sources.filter((s) => s.etat === "ko");
  return el("details", { class: `carte sources${enPanne.length ? " panne" : ""}` },
    el("summary", { texte: enPanne.length
      ? `Sources en panne à la dernière veille : ${enPanne.map((s) => s.nom).join(", ")}`
      : `${sources.length} sources lues à la dernière veille` }),
    el("div", {}, sources.map((s) => el("div", { class: "lancement" },
      el("span", { class: s.etat === "ok" ? null : "ko", texte: s.nom }),
      el("span", { class: "aide", texte: s.etat === "ok"
        ? `${s.articles ?? 0} article${(s.articles ?? 0) > 1 ? "s" : ""} · ${s.citations ?? 0} citation${(s.citations ?? 0) > 1 ? "s" : ""}`
        : (s.erreur || "inaccessible") })))));
}

async function suivreGeneration(zone) {
  const g = lireJSON(CLES.generation, null);
  if (!g) { zone.replaceChildren(); return; }
  if (Date.now() - g.depuis > 20 * 60e3) {
    garder(CLES.generation, null);
    zone.replaceChildren(el("div", { class: "carte alerte" },
      el("p", { texte: "La génération n'a rien donné après 20 minutes : regarde les derniers lancements dans ⚙." })));
    return;
  }
  zone.replaceChildren(el("div", { class: "carte etat" },
    el("div", { class: "etat-tete" }, el("span", { class: "voyant encours" }), el("strong", { texte: "Mise en forme en cours…" })),
    el("p", { class: "aide", texte: `${FORMATS[g.format]} · lancée à ${heureCourte(new Date(g.depuis).toISOString())}. Compte 3 à 5 minutes.` })));
  try {
    const index = await (await contenu("citations/index.json")).json();
    const voulue = [...g.ids].sort().join(",");
    const prete = (index.productions || []).find((p) => [...(p.ids || [])].sort().join(",") === voulue
      && new Date(p.genere_le).getTime() >= g.depuis - 120e3);
    if (prete) {
      garder(CLES.generation, null);
      toast("C'est prêt !");
      location.hash = `#/production/${encodeURIComponent(cheminProduction(prete))}`;
    }
  } catch (x) { /* index pas encore créé : on réessaiera */ }
}

/** « Aujourd'hui », « Hier », sinon « 11 novembre » : les intertitres de la liste. */
function jourCitation(iso) {
  if (!iso) return "Date inconnue";
  const jour = fmtJour(new Date(iso));
  if (jour === fmtJour(new Date())) return "Aujourd'hui";
  if (jour === fmtJour(new Date(Date.now() - 86400e3))) return "Hier";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "Europe/Paris" });
}

/** La veille lancée à la main depuis l'appli : on la suit jusqu'à ce que la liste change. */
async function suivreVeille(zone, recharger) {
  const v = lireJSON(CLES.veille, null);
  if (!v) return;
  if (Date.now() - v.depuis > 15 * 60e3) {
    garder(CLES.veille, null);
    zone.replaceChildren(el("div", { class: "carte alerte" },
      el("p", { texte: "La veille n'a rien donné après 15 minutes : regarde les derniers lancements dans ⚙." })));
    return;
  }
  zone.replaceChildren(el("div", { class: "carte etat" },
    el("div", { class: "etat-tete" }, el("span", { class: "voyant encours" }), el("strong", { texte: "Veille en cours…" })),
    el("p", { class: "aide", texte: `Lancée à ${heureCourte(new Date(v.depuis).toISOString())}. Compte 2 à 3 minutes : la liste se mettra à jour toute seule.` })));
  try {
    const veille = await (await contenu("citations/candidats.json")).json();
    if (veille.mis_a_jour && new Date(veille.mis_a_jour).getTime() >= v.depuis - 60e3) {
      garder(CLES.veille, null);
      const connues = new Set(v.ids || []);
      const neuves = (veille.candidats || []).filter((c) => !connues.has(c.id)).length;
      toast(neuves ? `Veille terminée : ${neuves} nouvelle${neuves > 1 ? "s" : ""} citation${neuves > 1 ? "s" : ""}` : "Veille terminée : rien de nouveau");
      etat.citJoueur = null;                       // les nouveautés se voient, quel que soit le joueur
      recharger();
    }
  } catch (x) { /* fichier pas encore réécrit : on réessaiera */ }
}

/** Une production prête à publier (index des citations). */
function carteProduction(p) {
  return el("button", {
    class: "carte nuit", onclick: () => (location.hash = `#/production/${encodeURIComponent(cheminProduction(p))}`),
  },
    el("span", { class: "date", texte: p.titre || FORMATS[p.format] }),
    el("span", { class: "meta", texte: `${FORMATS[p.format] || p.format} · ${quandCourt(p.genere_le)}` }),
    el("span", { class: "pastilles" },
      estPubliee(cheminProduction(p), "citations") ? el("span", { class: "pastille fluo", texte: "Publiée ✓" }) : null,
      el("span", { class: "pastille", texte: `${p.images} image${p.images > 1 ? "s" : ""}` }),
      p.alertes ? el("span", { class: "pastille rouge", texte: "à vérifier" }) : null));
}

/** Dernier passage de la veille et bouton pour la relancer à la main. */
function carteVeille(miseAJour, idsConnus, zoneSuivi, recharger) {
  const bouton = el("button", { class: "btn" }, "Lancer une veille");
  bouton.disabled = Boolean(lireJSON(CLES.veille, null));
  bouton.addEventListener("click", async () => {
    bouton.disabled = true;
    try {
      await gh(`/repos/${etat.depot}/actions/workflows/${CITATIONS}/dispatches`,
        { methode: "POST", corps: { ref: "main", inputs: { mode: "veille" } } });
      garder(CLES.veille, JSON.stringify({ depuis: Date.now(), ids: idsConnus }));
      toast("Veille lancée");
      suivreVeille(zoneSuivi, recharger);
    } catch (x) {
      if (x.message !== "401") toast(`Lancement refusé : ${x.message}`);
      bouton.disabled = false;
    }
  });
  return el("div", { class: "carte veille" },
    el("div", {},
      el("p", { class: "r-titre", texte: "Veille des déclarations" }),
      el("p", { class: "aide", texte: miseAJour ? `Dernier passage : ${quandCourt(miseAJour)}` : "Pas encore de passage" }),
      el("p", { class: "aide", texte: "Automatique vers 8h, 14h et 20h." })),
    bouton);
}

async function ecranCitations() {
  const tete = entete("Citations", "Chargement…", { retour: true });
  afficher(tete, el("p", { class: "aide", texte: "Chargement…" }));
  let candidats = [], productions = [], sources = [], alertesVeille = [], miseAJour = null;
  try {
    const veille = await (await contenu("citations/candidats.json")).json();
    candidats = veille.candidats || [];
    sources = veille.sources || [];
    alertesVeille = (veille.alertes || []).filter(Boolean);
    miseAJour = veille.mis_a_jour || null;
  } catch (x) { if (x.message === "401") return; }
  try {
    productions = (await (await contenu("citations/index.json")).json()).productions || [];
  } catch (x) { if (x.message === "401") return; }
  etat.citSel ||= new Set();
  etat.citOpt ||= {};
  const connus = new Set(candidats.map((c) => c.id));
  etat.citSel.forEach((id) => { if (!connus.has(id)) etat.citSel.delete(id); });

  const suivi = el("div", {});
  const bouton = el("button", { class: "btn principal", disabled: true });
  const majBarre = () => {
    const choisies = candidats.filter((c) => etat.citSel.has(c.id));
    const fmt = formatPour(choisies);
    bouton.disabled = !fmt || Boolean(lireJSON(CLES.generation, null));
    bouton.textContent = fmt ? `Générer · ${FORMATS[fmt]} (${choisies.length})` : "Coche une ou plusieurs citations";
  };
  bouton.addEventListener("click", async () => {
    const choisies = candidats.filter((c) => etat.citSel.has(c.id));
    const fmt = formatPour(choisies);
    if (!fmt) return;
    bouton.disabled = true;
    try {
      await gh(`/repos/${etat.depot}/actions/workflows/${CITATIONS}/dispatches`, {
        methode: "POST", corps: { ref: "main", inputs: { mode: "generer", ids: choisies.map((c) => c.id).join(","),
          options: JSON.stringify(Object.fromEntries(choisies.map((c) => [c.id, optionsDe(c)])
            .filter(([, o]) => Object.keys(o).length))) } } });
      garder(CLES.generation, JSON.stringify({ ids: choisies.map((c) => c.id), format: fmt, depuis: Date.now() }));
      etat.citSel.clear();
      etat.citOpt = {};
      ecranCitations();
    } catch (x) {
      if (x.message !== "401") toast(`Lancement refusé : ${x.message}`);
      majBarre();
    }
  });

  // de la plus récente à la plus ancienne, avec un intertitre par jour ; filtre par joueur au choix
  candidats.sort((a, b) => (b.publiee || "").localeCompare(a.publiee || ""));
  const parJoueur = new Map();
  for (const c of candidats) parJoueur.set(c.joueur, (parJoueur.get(c.joueur) || 0) + 1);
  if (etat.citJoueur && !parJoueur.has(etat.citJoueur)) etat.citJoueur = null;
  const zoneListe = el("div", {});
  const zoneFiltres = el("div", { class: "pastilles filtres" });
  const rendreListe = () => {
    zoneFiltres.replaceChildren(
      el("button", { class: `pastille filtre${etat.citJoueur ? "" : " actif"}`,
        onclick: () => { etat.citJoueur = null; rendreListe(); } }, `Tous · ${candidats.length}`),
      ...[...parJoueur.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([j, n]) =>
        el("button", { class: `pastille filtre${etat.citJoueur === j ? " actif" : ""}`,
          onclick: () => { etat.citJoueur = etat.citJoueur === j ? null : j; rendreListe(); } }, `${j} · ${n}`)));
    const visibles = candidats.filter((c) => !etat.citJoueur || c.joueur === etat.citJoueur);
    const jours = new Map();
    for (const c of visibles) {
      const j = jourCitation(c.publiee);
      if (!jours.has(j)) jours.set(j, []);
      jours.get(j).push(c);
    }
    zoneListe.replaceChildren(...[...jours.entries()].map(([jour, liste]) => el("div", { class: "groupe" },
      el("h3", { class: "groupe-titre", texte: jour }),
      el("div", { class: "liste" }, liste.map((c) => carteCandidat(c, majBarre))))));
  };
  rendreListe();

  afficher(
    entete("Citations", candidats.length ? `${candidats.length} repérée${candidats.length > 1 ? "s" : ""} · 4 derniers jours` : "Veille des déclarations", { retour: true }),
    suivi,
    carteVeille(miseAJour, candidats.map((c) => c.id), suivi, ecranCitations),
    bandeauSources(sources),
    alertesVeille.length ? el("div", { class: "carte alerte-orange" },
      alertesVeille.map((a) => el("p", { texte: a }))) : null,
    productions.length ? el("section", { class: "section" }, el("h2", { texte: "Prêtes à publier" }),
      // les deux dernières en vue, les autres repliées : les citations restent à portée de pouce
      el("div", { class: "liste" }, productions.slice(0, 2).map(carteProduction)),
      productions.length > 2 ? el("details", { class: "plus" },
        el("summary", { texte: `${productions.length - 2} production${productions.length > 3 ? "s" : ""} plus ancienne${productions.length > 3 ? "s" : ""}` }),
        el("div", { class: "liste" }, productions.slice(2).map(carteProduction))) : null) : null,
    el("section", { class: "section" }, el("h2", { texte: "Citations repérées" }),
      candidats.length
        ? [parJoueur.size > 1 ? zoneFiltres : null, zoneListe]
        : el("p", { class: "aide", texte: "Rien de neuf pour l'instant. La veille passe vers 8h, 14h et 20h, ou lance-la ci-dessus." })),
    el("div", { class: "barre" }, bouton));
  majBarre();
  // une seule zone de suivi : la génération en cours d'abord, sinon la veille lancée à la main
  const suivre = () => (lireJSON(CLES.generation, null) ? suivreGeneration(suivi) : suivreVeille(suivi, ecranCitations));
  suivre();
  etat.minuterie = setInterval(() => { suivre(); majBarre(); }, 15000);
}

/* --- notifications --- */

function octetsDepuisB64(b64) {
  const brut = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(brut, (c) => c.charCodeAt(0));
}

function sectionNotifications() {
  const statut = el("p", { class: "aide" });
  const bouton = el("button", { class: "btn" });
  const possible = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const majStatut = async () => {
    if (!possible) {
      statut.textContent = "Ce navigateur ne gère pas les notifications. Installe l'appli depuis Chrome.";
      bouton.classList.add("cache"); return;
    }
    const reg = await navigator.serviceWorker.ready;
    const abo = await reg.pushManager.getSubscription();
    if (Notification.permission === "denied") {
      statut.textContent = "Notifications bloquées : autorise-les dans les réglages Android de l'appli.";
      bouton.classList.add("cache");
    } else if (abo) {
      statut.textContent = "Ce téléphone est prévenu chaque matin quand la nuit est prête.";
      bouton.textContent = "Envoyer une notification d'essai";
      bouton.onclick = () => lancerReglage({ action: "tester" }, "Essai envoyé : la notification arrive dans une minute environ.");
    } else {
      statut.textContent = "Être prévenu chaque matin quand la nuit est prête.";
      bouton.textContent = "Activer les notifications";
      bouton.onclick = activer;
    }
  };
  const activer = async () => {
    bouton.disabled = true;
    try {
      const reglage = await (await contenu("reglages/notifications.json")).json().catch(() => null);
      if (!reglage?.cle_publique) throw new Error("les notifications ne sont pas encore configurées côté GitHub");
      if (await Notification.requestPermission() !== "granted") throw new Error("autorisation refusée");
      const reg = await navigator.serviceWorker.ready;
      const abo = await reg.pushManager.subscribe({ userVisibleOnly: true,
        applicationServerKey: octetsDepuisB64(reglage.cle_publique) });
      await lancerReglage({ action: "abonner", abonnement: JSON.stringify(abo) },
        "C'est activé : une notification d'essai arrive dans une minute environ.");
    } catch (x) {
      if (x.message !== "401") toast(x.message.startsWith("GitHub") ? "Configuration introuvable sur GitHub." : `Impossible : ${x.message}`);
    } finally { bouton.disabled = false; majStatut(); }
  };
  majStatut();
  return el("section", { class: "section" }, el("h2", { texte: "Notifications" }),
    el("div", { class: "carte liste" }, statut, bouton));
}

async function lancerReglage(inputs, message) {
  try {
    await gh(`/repos/${etat.depot}/actions/workflows/${REGLAGES}/dispatches`,
             { methode: "POST", corps: { ref: "main", inputs } });
    toast(message);
  } catch (x) {
    if (x.message !== "401") toast(`Refusé par GitHub : ${x.message}`);
  }
}

/* --- relancer --- */

const STATUTS = { queued: "en attente", in_progress: "en cours", completed: "terminé", waiting: "en attente" };
const ISSUES = { success: "réussi", failure: "échec", cancelled: "annulé", skipped: "ignoré" };

async function majLancements(zone) {
  try {
    const r = await (await gh(`/repos/${etat.depot}/actions/workflows/${WORKFLOW}/runs?per_page=6`)).json();
    zone.replaceChildren(...r.workflow_runs.map((run) => {
      const quand = new Date(run.created_at).toLocaleString("fr-FR", { weekday: "short", day: "numeric",
        month: "short", hour: "2-digit", minute: "2-digit" });
      const fini = run.status === "completed";
      const classe = !fini ? "encours" : run.conclusion === "success" ? "ok" : "ko";
      return el("div", { class: "lancement" },
        el("span", { texte: `${quand} · ${run.event === "schedule" ? "automatique" : "manuel"}` }),
        el("span", { class: classe, texte: fini ? (ISSUES[run.conclusion] || run.conclusion) : (STATUTS[run.status] || run.status) }));
    }));
  } catch (x) {
    if (x.message !== "401") zone.replaceChildren(el("p", { class: "aide", texte: `Historique indisponible : ${x.message}` }));
  }
}

function ecranRelancer() {
  const date = el("input", { type: "date", id: "date", value: nuitNBA() });
  const mail = el("input", { type: "checkbox", id: "mail" });
  const historique = el("div", {}, el("p", { class: "aide", texte: "Chargement…" }));
  const bouton = el("button", { class: "btn principal", onclick: async () => {
    bouton.disabled = true;
    try {
      await gh(`/repos/${etat.depot}/actions/workflows/${WORKFLOW}/dispatches`, {
        methode: "POST",
        corps: { ref: "main", inputs: { date: date.value, envoyer_mail: mail.checked ? "true" : "false" } },
      });
      toast("C'est lancé : la nuit sera prête dans 5 minutes environ.");
      setTimeout(() => majLancements(historique), 4000);
    } catch (x) {
      if (x.message !== "401") toast(`Lancement refusé : ${x.message}`);
    } finally { bouton.disabled = false; }
  } }, "Lancer");

  afficher(
    entete("Réglages", "Relancer, notifications", { retour: true }),
    el("div", { class: "carte liste" },
      el("div", { class: "champ" }, el("label", { for: "date", texte: "Nuit NBA (heure de New York)" }), date),
      el("label", { class: "aide", for: "mail" }, mail, " Envoyer aussi le mail"),
      bouton),
    el("section", { class: "section" }, el("h2", { texte: "Derniers lancements" }), el("div", { class: "carte" }, historique)),
    sectionNotifications(),
    el("section", { class: "section" },
      el("button", { class: "btn", onclick: () => { if (confirm("Oublier le code d'accès sur ce téléphone ?")) deconnecter(); } },
        "Se déconnecter")));
  majLancements(historique);
  etat.minuterie = setInterval(() => majLancements(historique), 15000);
}

/* ------------------------------------------------------------------ routage */

function router() {
  clearInterval(etat.minuterie);
  if (!etat.jeton || !etat.depot) { ecranConnexion(); return; }
  const route = location.hash.replace(/^#\/?/, "");
  if (route.startsWith("nuit/")) ecranNuit(route.slice(5));
  else if (route === "relancer") ecranRelancer();
  else if (route === "bleus") ecranBleus();
  else if (route === "citations") ecranCitations();
  else if (route === "mercato") ecranMercato();
  else if (route.startsWith("mercato/")) ecranMouvement(decodeURIComponent(route.slice(8)));
  else if (route.startsWith("production/")) ecranNuit(decodeURIComponent(route.slice(11)));
  else ecranListe();
}

window.addEventListener("hashchange", router);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
router();
