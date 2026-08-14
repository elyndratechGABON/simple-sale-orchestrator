# Design

> Auto-generated and maintained by frontend-god-mode.
> Source of truth for typography, color, motion, layout, and component tokens.
> Read this BEFORE touching the UI in any subsequent session.

Scope: `dashboard/` (console d'administration des caisses). Le reste du monorepo
(POS PWA, landing) garde son propre design.

## Aesthetic direction

« Console d'ops » — utilitaire et soignée : rail sombre zinc à gauche, espace de
travail clair, un seul accent bleu électrique désaturé. Le rail fait office de
sélecteur de projets (bascule en un clic), les données sont en mono à chiffres
tabulaires.

## Dials

- DESIGN_VARIANCE: 4 / 10
- MOTION_INTENSITY: 3 / 10
- VISUAL_DENSITY: 6 / 10

## Type stack

- Display: Geist (weights 400–700)
- Body: Geist
- Mono: JetBrains Mono (device_id, timestamps, compteurs)
- Loaded via: Google Fonts (`<link>` dans `dashboard/index.html`), fallback
  `ui-sans-serif` / `ui-monospace` si hors ligne

Banned in this project: Inter, Roboto, Arial, system-ui comme police principale,
serif sur dashboard.

## Color tokens (OKLCH)

```css
:root {
  --bg:      oklch(0.982 0.004 252);   /* fond clair, teinte cool */
  --surface: oklch(0.999 0 252);       /* cartes / table */
  --border:  oklch(0.918 0.009 252);
  --text:    oklch(0.24 0.02 252);
  --muted:   oklch(0.54 0.02 252);
  --accent:  oklch(0.55 0.18 252);     /* bleu électrique désaturé */
  --ok:      oklch(0.55 0.14 152);     /* emerald */
  --warn:    oklch(0.6 0.13 75);       /* amber */
  --danger:  oklch(0.55 0.17 12);      /* rose */

  /* rail toujours sombre */
  --rail:          oklch(0.165 0.02 252);
  --rail-accent:   oklch(0.74 0.16 252);
}
/* variantes dark via prefers-color-scheme : accents + saturés, bg 0.15-0.2 */
```

Banned in this project:
- Pure #000 / #FFF (neutres teintés uniquement)
- Dégradés violet→bleu
- Plus d'UN accent

## Shadows

Teintées vers la teinte de fond — jamais de noir pur :

```css
--shadow:       0 1px 2px oklch(0.2 0.02 252 / 0.05), 0 8px 24px -12px oklch(0.2 0.02 252 / 0.1);
--shadow-modal: 0 4px 12px oklch(0.2 0.02 252 / 0.08), 0 24px 48px -16px oklch(0.2 0.02 252 / 0.18);
```

## Motion

- CSS uniquement, transitions courtes `0.12–0.18s`
- Micro-interactions : pulsation de la pastille « en ligne », shimmer des skeletons,
  entrée de modale (`translateY(6px)` + fade)
- Banned: easing linéaire, bounce/elastic, animation de width/height, boucles
  perpétuelles non isolées
- `prefers-reduced-motion` : tout est figé

## Layout

- Shell : `grid-template-columns: 264px 1fr` — rail fixe + espace de travail
- Rail : sombre, sticky, `height: 100dvh`, projets cliquables (un clic = filtre)
- Stats : bande « divide-y » (pas de cartes) — `Caisses / En ligne / Actives / En attente`
- Table : `divide-y`, numériques en mono, pastille de présence
- Mobile (< 880 px) : rail en bandeau supérieur avec chips de projets défilants,
  table scrollable horizontalement

## Component inventory

Custom (zéro dépendance) : Rail (sélecteur de projets), TopBar (titre + recherche +
indicateur Live), Stats, Table + ShopRow (historique extensible), modales
(Prolonger / Message / Mot de passe projet), Login.

Icônes : SVG inline dans `dashboard/src/icons.tsx`, stroke 1.75, jamais d'émojis.

## Project-specific bans

- Pas d'émojis (SVG seulement)
- Pas de `h-screen` (toujours `100dvh`)
- Pas de cartes 3-en-rang (bande de stats à la place)
- Pas de bouton imbriqué dans un bouton (le cadenas de projet est un frère de
  `rail-main`, pas un enfant)

## Brand voice (copy)

- Ton : direct, technique, court. Labels d'action en verbes précis
  (« Suspendre », « Prolonger », « Relancer », « Envoyer »)
- Banned: elevate, seamless, unleash, next-gen, game-changing

## Accessibility floor

- Contrast body ≥ 4.5:1 (WCAG AA)
- Focus-visible rings sur chaque élément interactif (`outline: 2px accent`)
- `prefers-reduced-motion` respecté
- Labels réels sur les champs de formulaire (login, modales)
- HTML valide : pas de `<button>` imbriqué

## Last updated

2026-08-14 by [refonte du dashboard : rail de projets un-clic, console d'ops moderne]
