# Vendored files

The page loads every file from the office server. Nothing comes from a CDN or a font service (security audit #27, M2). The server serves these files from its exact-match list (`STATIC_FILES` in `server.mjs`). The content security policy (`auth.mjs`, `CSP`) allows scripts, style sheets and fonts from the office's own origin only.

The files are kept byte for byte as published (`.gitattributes`: `public/vendor/** -text`). `test/static.test.mjs` checks the React hashes below and fails when a file changes.

## React 18.3.1

| File | Source | SHA-256 |
| --- | --- | --- |
| `react.production.min.js` | `react@18.3.1`, `umd/react.production.min.js` | `d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd` |
| `react-dom.production.min.js` | `react-dom@18.3.1`, `umd/react-dom.production.min.js` | `35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d` |
| `react-LICENSE.txt` | `react@18.3.1`, `LICENSE` (MIT; the same text is in `react-dom@18.3.1`) | `52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85` |

Taken from the npm registry tarballs (`npm pack react@18.3.1 react-dom@18.3.1`; npm checks the registry integrity, `sha512-wS+hAgJS...` and `sha512-5m4nQKp+...`). They are the same bytes that the page loaded before from `https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js` and `https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js`. Both files start with `@license React` and contain the version string `"18.3.1"`.

### Update React

1. In an empty folder outside the repository: `npm pack react@<v> react-dom@<v>`, then unpack both tarballs.
2. Copy `package/umd/react.production.min.js`, `package/umd/react-dom.production.min.js` and `package/LICENSE` (as `react-LICENSE.txt`) here.
3. Check the version string in each file, and get the new hashes: `sha256sum *.js *.txt`.
4. Put the new hashes in this table and in `test/static.test.mjs`. Run `npm test`, then load the page and look at the console.

## Fonts

`fonts/fonts.css` is the style sheet that Google Fonts gave for the DS font request (the request `components/bundle.css` imported before), with only the `src` URLs changed to the files next to it:

`https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..700&family=Chivo+Mono:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=VT323&display=swap`

Fetched 2026-11-04 with a Chromium user agent, so every face is woff2. All subsets are kept (latin, latin-ext, vietnamese, and cyrillic, cyrillic-ext and greek where the family has them), so text in those scripts uses the same fonts as before. 48 faces in 30 files, 613 KB. The files are unchanged from `fonts.gstatic.com`. Archivo, Chivo Mono and IBM Plex Sans are variable fonts: one file serves every weight. Licenses: SIL Open Font License 1.1, one text per family (`fonts/OFL-*.txt`, from `github.com/google/fonts`, `ofl/<family>/OFL.txt`). IBM Plex has the Reserved Font Name "Plex".

| File | Source (`https://fonts.gstatic.com/s/...`) | SHA-256 |
| --- | --- | --- |
| `archivo-latin-ext.woff2` | `archivo/v25/k3kQo8UDI-1M0wlSfdfoLnnA.woff2` | `5717f37059660ca5c899bad6c48ee22c3ac55cb3c484055241689d0f905a1a86` |
| `archivo-latin.woff2` | `archivo/v25/k3kQo8UDI-1M0wlSfdnoLg.woff2` | `e3a28eade21a900c7155a247757f4b2834c07bb7ef07ad7efa55cebaac1e8f5e` |
| `archivo-vietnamese.woff2` | `archivo/v25/k3kQo8UDI-1M0wlSfdboLnnA.woff2` | `332e6f66de84927cdffc60894e4e186ced783f5cb4b3e88200f45b7c1d306810` |
| `chivo-mono-latin-ext.woff2` | `chivomono/v11/mFT0WbgRxKvF_Z5eQMO9gxED1XJ7.woff2` | `479a6414d1d35c272018d9a6effde625afbac888bf75c48868652284cbb8b7d6` |
| `chivo-mono-latin.woff2` | `chivomono/v11/mFT0WbgRxKvF_Z5eQMO9gx8D1Q.woff2` | `c00775f8ecb034b6c193c7b253d698cfe882a1d6c0df67299a3d5382c2e82216` |
| `chivo-mono-vietnamese.woff2` | `chivomono/v11/mFT0WbgRxKvF_Z5eQMO9gxAD1XJ7.woff2` | `99143cc4e776066ab238ee62b21217a2112e4be470eb3572d8a0f37a537b2677` |
| `ibm-plex-mono-400-cyrillic-ext.woff2` | `ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1iIq129k.woff2` | `f8c22ec1804bd6966b70f43ac7c327025645b4c09597117fca2a5a6c750106fe` |
| `ibm-plex-mono-400-cyrillic.woff2` | `ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1isq129k.woff2` | `7635422bd10ddbbcb0e0caa1154b928298f5c8319b8c00b30978d4395f4783ce` |
| `ibm-plex-mono-400-latin-ext.woff2` | `ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1iEq129k.woff2` | `6bc0f226a5b7884a8170e3f62c63d7675609d4631bdc5931b5cdab81821f00eb` |
| `ibm-plex-mono-400-latin.woff2` | `ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2` | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` |
| `ibm-plex-mono-400-vietnamese.woff2` | `ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1iAq129k.woff2` | `62632b6375305e70ddcafdd895218e6ae41a184fcd280a69c739460604ca00a9` |
| `ibm-plex-mono-500-cyrillic-ext.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl1FgtIU.woff2` | `3febe5c7f22e4b07b4552738673c3dbe8bced2dc5f48b866edf7ccd9552d109a` |
| `ibm-plex-mono-500-cyrillic.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlRFgtIU.woff2` | `1d89462e86cb8e87e7e9d6f6635605bd7c3081baca6caaecee84916bf7b60edc` |
| `ibm-plex-mono-500-latin-ext.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl5FgtIU.woff2` | `6bb06407c97584b0867a959e05e8874693bfeb8c317de190811c51598f2d99ea` |
| `ibm-plex-mono-500-latin.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgg.woff2` | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` |
| `ibm-plex-mono-500-vietnamese.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl9FgtIU.woff2` | `781633d95de88040fb77141d1e65d928c87c0144691fbc74da5a64d137a7e910` |
| `ibm-plex-mono-600-cyrillic-ext.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwl1FgtIU.woff2` | `83109cdd4f8665b475dfc11d61bd44da328bf7e6eab3d3953d39c49b1b9f6015` |
| `ibm-plex-mono-600-cyrillic.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwlRFgtIU.woff2` | `2b05a8695c7f9f4abd7178b279646a3b005a8ce57546bef6fd145f25d131e0aa` |
| `ibm-plex-mono-600-latin-ext.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwl5FgtIU.woff2` | `32057cf50dd14bdb21a2c93766c4a2c43e4abe688ea3922df3203cac7751a98b` |
| `ibm-plex-mono-600-latin.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwlBFgg.woff2` | `0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83` |
| `ibm-plex-mono-600-vietnamese.woff2` | `ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwl9FgtIU.woff2` | `51b74d53e106ba8a26dd33464b231a562069be2a234b923c115beb622e6f6bc6` |
| `ibm-plex-sans-cyrillic-ext.woff2` | `ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxTKYbABA.woff2` | `7d0037a170882a49e65a45c38ef195237bb07b1cc791d078379f0ac0d7ae1935` |
| `ibm-plex-sans-cyrillic.woff2` | `ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxaKYbABA.woff2` | `9409ee21811f0f5272b7e1d828fe8838005b0573481ef906e7e55b63f6610ab0` |
| `ibm-plex-sans-greek.woff2` | `ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxdKYbABA.woff2` | `f598dd0700f155e2facfaa8ecfacace397d4c2c153e9ce37ab7ad310e8505bc2` |
| `ibm-plex-sans-latin-ext.woff2` | `ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxQKYbABA.woff2` | `d160e20920ae4d6556518d352d3af27a74e9b0de3d8fe17b1c1044fc75aa2f81` |
| `ibm-plex-sans-latin.woff2` | `ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxeKYY.woff2` | `e2291e842cf5af167122a22881a740c7f2dda7716f1e8cd76680264f4a859470` |
| `ibm-plex-sans-vietnamese.woff2` | `ibmplexsans/v23/zYXzKVElMYYaJe8bpLHnCwDKr932-G7dytD-Dmu1syxRKYbABA.woff2` | `73e7f7b1c980416ae0c2461268b14c7cfcce0668e683dc43fbb11a82a227b9f2` |
| `vt323-latin-ext.woff2` | `vt323/v18/pxiKyp0ihIEF2isRFJXGdg.woff2` | `4435f062ebe744d097d0d618ac5ad6b8ea25ee3bd6004c5369c24518e70af1f0` |
| `vt323-latin.woff2` | `vt323/v18/pxiKyp0ihIEF2isfFJU.woff2` | `8ddbebcc1048154132e1d78eb9b1f7850bca1b7d857035ccf1cb4318ebc615b6` |
| `vt323-vietnamese.woff2` | `vt323/v18/pxiKyp0ihIEF2isQFJXGdg.woff2` | `84b335a53b55c33f919f11b5cf83d857f053097171461eaba10d44be1c623609` |

### Update the fonts

1. In an empty folder outside the repository, get the style sheet with a current Chromium user agent (an old one gets ttf): `curl -A "<Chrome user agent>" -o google.css "<the URL above>"`.
2. Download every `https://fonts.gstatic.com/...woff2` URL in it.
3. Name each file `<family>-<subset>.woff2`, with the weight between them when the family has one file per weight (IBM Plex Mono: `ibm-plex-mono-500-latin.woff2`). Only lower-case letters, digits and `-`: the server serves no other font name.
4. Write `fonts/fonts.css`: the Google style sheet with each URL changed to its file name. Keep the header comment.
5. Put the new hashes in the table above. Run `npm test` (it checks that every file `fonts.css` names is here and served), then load the page in Day, Night and Sublevel.
