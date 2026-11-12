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
const CLES = { jeton: "ndb.jeton", depot: "ndb.depot", publie: "ndb.publie" };
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
      estPubliee(n.nuit, "carrousel") ? el("span", { class: "pastille fluo", texte: "Publiée ✓" }) : null,
      el("span", { class: "pastille", texte: `${n.images} images` }),
      n.choix ? el("span", { class: "pastille", texte: n.choix > 1 ? `${n.choix} choix` : "1 choix" }) : null,
      n.alertes ? el("span", { class: "pastille rouge", texte: "à vérifier" }) : null)));
  afficher(tete, carteEtat(index),
    el("section", { class: "section" }, el("h2", { texte: "Les nuits" }),
      el("div", { class: "liste" },
        cartes.length ? cartes : el("p", { class: "aide", texte: "Aucune nuit publiée pour l'instant." }))));
}

/* --- une nuit ---
 * Une nuit peut contenir plusieurs publications : le carrousel du matin, et des
 * posts à part (citations…), repérés par la clé « publication » de chaque image.
 * Chaque publication a son aperçu, sa légende et son bouton « Publier ».
 * Chaque image peut être retirée ou déplacée ; l'ordre de départ est celui du matin. */

const NOMS_PUBLICATION = { carrousel: "Le carrousel", citations: "Les citations" };
const pubDe = (im) => im.publication || "carrousel";
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
  return pub === "carrousel" ? "base" : pub;
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
    afficher(tete, el("div", { class: "carte alerte" }, el("p", { texte: `Nuit introuvable : ${x.message}` })));
    return;
  }
  Object.values(etat.urls).forEach((u) => URL.revokeObjectURL(u));
  etat.fiche = fiche; etat.fichiers = {}; etat.urls = {}; etat.legendeModifiee = {};
  etat.choix = Object.fromEntries(fiche.choix.map((c) => [c.id, c.defaut !== false]));
  etat.retirees = new Set(); etat.ton = {}; etat.tagsRetires = {};
  etat.ordre = {}; etat.ordreInitial = {};
  for (const pub of publications()) {
    etat.ordreInitial[pub] = fiche.images.filter((im) => pubDe(im) === pub).map((im) => im.fichier);
    etat.ordre[pub] = [...etat.ordreInitial[pub]];
  }

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
  publications().forEach(majMarquePublication);
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
