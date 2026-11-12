"use strict";
/* Pilotage de La Nuit des Bleus.
 *
 * L'appli ne contient aucune donnée : tout est lu dans le dépôt privé (branche
 * « contenus ») avec le code d'accès saisi au premier lancement, qui reste sur le
 * téléphone. Sans ce code, on ne voit que l'écran de connexion.
 *
 * Les choix (garder ou non un encart…) ne relancent aucune fabrication : toutes les
 * variantes sont déjà rendues, l'appli ne fait que les assembler.
 */

const API = "https://api.github.com";
const WORKFLOW = "matin.yml";
const CLES = { jeton: "ndb.jeton", depot: "ndb.depot" };
const $app = document.getElementById("app");

const etat = {
  jeton: lire(CLES.jeton), depot: lire(CLES.depot),
  fiche: null, fichiers: {}, urls: {}, choix: {}, legendeModifiee: {}, minuterie: null,
};

/* ------------------------------------------------------------------ outils */

function lire(cle) { try { return localStorage.getItem(cle); } catch { return null; } }
function garder(cle, valeur) {
  try { valeur == null ? localStorage.removeItem(cle) : localStorage.setItem(cle, valeur); } catch { /* navigation privée */ }
}

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

/** La nuit NBA en cours de traitement : heure de New York moins 6 h. */
function nuitNBA() {
  const d = new Date(Date.now() - 6 * 3600e3);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
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

async function ecranListe() {
  const relancer = el("button", { class: "icone", "aria-label": "Relancer une nuit",
                                  onclick: () => (location.hash = "#/relancer") }, "↻");
  const tete = entete("La nuit des Bleus", "Pilotage", { droite: relancer });
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
      el("span", { class: "pastille", texte: `${n.images} images` }),
      n.choix ? el("span", { class: "pastille fluo", texte: n.choix > 1 ? `${n.choix} choix à faire` : "1 choix à faire" }) : null,
      n.alertes ? el("span", { class: "pastille rouge", texte: "à vérifier" }) : null)));
  afficher(tete, el("div", { class: "liste" },
    cartes.length ? cartes : el("p", { class: "aide", texte: "Aucune nuit publiée pour l'instant." })));
}

/* --- une nuit ---
 * Une nuit peut contenir plusieurs publications : le carrousel du matin, et des
 * posts à part (citations…), repérés par la clé « publication » de chaque image.
 * Chaque publication a son aperçu, sa légende et son bouton « Publier ». */

const NOMS_PUBLICATION = { carrousel: "Le carrousel", citations: "Les citations" };
const pubDe = (im) => im.publication || "carrousel";
const nomPublication = (pub) => NOMS_PUBLICATION[pub] || pub;

function publications() {
  return [...new Set(etat.fiche.images.map(pubDe))];
}

function selection(pub) {
  return etat.fiche.images.filter((im) => pubDe(im) === pub
    && !(im.facultative && im.choix && etat.choix[im.choix] === false));
}

function pubDuChoix(c) {
  const im = etat.fiche.images.find((i) => i.choix === c.id);
  return im ? pubDe(im) : "carrousel";
}

function legendeCourante(pub) {
  const f = etat.fiche;
  for (const c of f.choix) {
    if (pubDuChoix(c) === pub && etat.choix[c.id] && c.legende && f.legendes[c.legende]) {
      return f.legendes[c.legende];
    }
  }
  return (pub === "carrousel" ? f.legendes.base : f.legendes[pub]) || "";
}

function vignette(im, rang, total) {
  const url = etat.urls[im.fichier];
  return el("figure", { class: `vignette${im.facultative ? " facultative" : ""}` },
    url ? el("img", { src: url, alt: im.titre }) : el("div", { class: "vide", texte: "Chargement…" }),
    el("figcaption", { class: "rang", texte: `${rang}/${total} · ${im.titre}` }));
}

function majApercu() {
  for (const pub of publications()) {
    const zone = document.getElementById(`apercu-${pub}`);
    if (!zone) continue;
    const sel = selection(pub);
    zone.replaceChildren(...(sel.length ? sel.map((im, i) => vignette(im, i + 1, sel.length))
      : [el("p", { class: "aide", texte: "Rien de retenu : rien à publier." })]));
    document.getElementById(`compte-${pub}`).textContent =
      `${nomPublication(pub)} · ${sel.length} image${sel.length > 1 ? "s" : ""}`;
    const bouton = document.getElementById(`publier-${pub}`);
    if (bouton) bouton.disabled = !sel.length;
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
    const pub = pubDuChoix(c);
    const zone = document.getElementById(`legende-${pub}`);
    if (zone && !etat.legendeModifiee[pub]) zone.value = legendeCourante(pub);
    else if (zone) toast("Légende modifiée à la main : pensez à la relire.");
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

function sectionPublication(pub) {
  const legende = el("textarea", { id: `legende-${pub}`, spellcheck: "true",
                                   oninput: () => (etat.legendeModifiee[pub] = true) });
  legende.value = legendeCourante(pub);
  return el("section", { class: "section" },
    el("h2", { id: `compte-${pub}` }),
    el("div", { class: "defile", id: `apercu-${pub}` }),
    el("h2", { texte: "La légende", class: "sous-titre" }), legende,
    el("div", { class: "rangee" },
      el("button", { class: "btn", onclick: async () => {
        try { await navigator.clipboard.writeText(legende.value); toast("Légende copiée."); }
        catch { legende.select(); toast("Copie refusée : sélectionnez le texte à la main."); }
      } }, "Copier la légende"),
      el("button", { class: "btn", onclick: () => enregistrer(fichiersDe(pub)) }, "Enregistrer")),
    el("button", { class: "btn principal publier", id: `publier-${pub}`, onclick: () => publier(pub) },
      publications().length > 1 ? `Publier ${nomPublication(pub).toLowerCase()}` : "Publier sur Instagram"));
}

async function ecranNuit(nuit) {
  const tete = entete("Chargement…", null, { retour: true });
  afficher(tete, el("p", { class: "aide", texte: "Chargement de la nuit…" }));
  let fiche;
  try {
    fiche = await (await contenu(`${nuit}/manifeste.json`)).json();
  } catch (x) {
    if (x.message === "401") return;
    afficher(tete, el("div", { class: "carte alerte" }, el("p", { texte: `Nuit introuvable : ${x.message}` })));
    return;
  }
  Object.values(etat.urls).forEach((u) => URL.revokeObjectURL(u));
  etat.fiche = fiche; etat.fichiers = {}; etat.urls = {}; etat.legendeModifiee = {};
  etat.choix = Object.fromEntries(fiche.choix.map((c) => [c.id, c.defaut !== false]));

  afficher(
    entete(fiche.date_fr || fiche.nuit, resumeTexte(fiche.resume), { retour: true }),
    fiche.alertes.length
      ? el("div", { class: "carte alerte" }, el("p", { texte: "À vérifier avant de publier :" }),
          fiche.alertes.map((a) => el("p", { texte: `• ${a}` })))
      : null,
    fiche.choix.length
      ? el("section", { class: "section" }, el("h2", { texte: "Tes choix" }),
          el("div", { class: "liste" }, fiche.choix.map(carteChoix)))
      : null,
    publications().map(sectionPublication));
  majApercu();
  chargerImages(nuit);
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
    entete("Relancer", "Refaire une nuit", { retour: true }),
    el("div", { class: "carte liste" },
      el("div", { class: "champ" }, el("label", { for: "date", texte: "Nuit NBA (heure de New York)" }), date),
      el("label", { class: "aide", for: "mail" }, mail, " Envoyer aussi le mail"),
      bouton),
    el("section", { class: "section" }, el("h2", { texte: "Derniers lancements" }), el("div", { class: "carte" }, historique)),
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
  else ecranListe();
}

window.addEventListener("hashchange", router);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
router();
