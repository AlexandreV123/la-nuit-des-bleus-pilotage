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
const CLES = { jeton: "ndb.jeton", depot: "ndb.depot", publie: "ndb.publie", generation: "ndb.generation" };
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
  afficher(tete, carteEtat(index),
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
                           ladders: "Le classement" };
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
const pubDe = (im) => im.publication || etat.fiche?.publication || "carrousel";
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
             || FORMATS[fiche.format] || "", { retour: true }),
    fiche.source
      ? el("p", { class: "aide" }, "Source : ",
          el("a", { href: fiche.source, target: "_blank", rel: "noopener noreferrer", texte: "NBA.com" }),
          " — publier une édition sur deux suffit.")
      : null,
    fiche.alertes.length
      ? el("div", { class: "carte alerte" }, el("p", { texte: "À vérifier avant de publier :" }),
          fiche.alertes.map((a) => el("p", { texte: `• ${a}` })))
      : null,
    fiche.choix.length
      ? el("section", { class: "section" }, el("h2", { texte: "Tes choix" }),
          el("div", { class: "liste" }, fiche.choix.map(carteChoix)))
      : null,
    publications().map(sectionPublication));
  publications().forEach(majMarquePublication);
  majApercu();
  chargerImages(nuit);
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
    el("label", { for: `c-${c.id}`, class: "cit-tete" }, coche,
      el("span", { class: "cit-texte", texte: `« ${c.citation} »` })),
    el("p", { class: "cit-qui", texte: qui }),
    m ? el("p", { class: "aide" }, m.contexte_fr || MOMENTS[m.moment] || "",
          m.moment_source === "heure" ? el("span", { class: "pastille rouge mini-p", texte: "moment à vérifier" }) : null) : null,
    el("div", { class: "pastilles" },
      el("span", { class: `pastille${c.suggestion === "garder" ? " fluo" : ""}`,
                   texte: c.suggestion === "garder" ? "Suggestion : garder" : "Suggestion : retirer" }),
      c.deja_produite ? el("span", { class: "pastille", texte: "déjà produite" }) : null,
      c.langue && c.langue !== "fr" ? el("span", { class: "pastille", texte: `en ${c.langue}` }) : null),
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

async function ecranCitations() {
  const tete = entete("Citations", "Chargement…", { retour: true });
  afficher(tete, el("p", { class: "aide", texte: "Chargement…" }));
  let candidats = [], productions = [], sources = [], alertesVeille = [];
  try {
    const veille = await (await contenu("citations/candidats.json")).json();
    candidats = veille.candidats || [];
    sources = veille.sources || [];
    alertesVeille = (veille.alertes || []).filter(Boolean);
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

  // groupées par joueur, les plus récentes d'abord (l'ordre du fichier)
  const groupes = new Map();
  for (const c of candidats) {
    if (!groupes.has(c.joueur)) groupes.set(c.joueur, []);
    groupes.get(c.joueur).push(c);
  }

  afficher(
    entete("Citations", candidats.length ? `${candidats.length} repérée${candidats.length > 1 ? "s" : ""} · 4 derniers jours` : "Veille des déclarations", { retour: true }),
    suivi,
    bandeauSources(sources),
    alertesVeille.length ? el("div", { class: "carte alerte-orange" },
      alertesVeille.map((a) => el("p", { texte: a }))) : null,
    productions.length ? el("section", { class: "section" }, el("h2", { texte: "Prêtes à publier" }),
      el("div", { class: "liste" }, productions.map((p) => el("button", {
        class: "carte nuit", onclick: () => (location.hash = `#/production/${encodeURIComponent(cheminProduction(p))}`),
      },
        el("span", { class: "date", texte: p.titre || FORMATS[p.format] }),
        el("span", { class: "meta", texte: `${FORMATS[p.format] || p.format} · ${quandCourt(p.genere_le)}` }),
        el("span", { class: "pastilles" },
          estPubliee(cheminProduction(p), "citations") ? el("span", { class: "pastille fluo", texte: "Publiée ✓" }) : null,
          el("span", { class: "pastille", texte: `${p.images} image${p.images > 1 ? "s" : ""}` }),
          p.alertes ? el("span", { class: "pastille rouge", texte: "à vérifier" }) : null))))) : null,
    el("section", { class: "section" }, el("h2", { texte: "Citations repérées" }),
      candidats.length
        ? [...groupes.entries()].map(([joueur, liste]) => el("div", { class: "groupe" },
            el("h3", { class: "groupe-titre", texte: joueur }),
            el("div", { class: "liste" }, liste.map((c) => carteCandidat(c, majBarre)))))
        : el("p", { class: "aide", texte: "Rien de neuf pour l'instant. La veille passe vers 8h, 14h et 20h." })),
    el("div", { class: "barre" }, bouton));
  majBarre();
  suivreGeneration(suivi);
  etat.minuterie = setInterval(() => { suivreGeneration(suivi); majBarre(); }, 15000);
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
  else if (route.startsWith("production/")) ecranNuit(decodeURIComponent(route.slice(11)));
  else ecranListe();
}

window.addEventListener("hashchange", router);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
router();
