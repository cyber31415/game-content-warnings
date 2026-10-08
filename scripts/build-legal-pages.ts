// Writes the Privacy Policy and Terms pages as static HTML into docs/ for GitHub Pages
// (Settings > Pages > Deploy from branch > main /docs). Same text the EBS serves at
// /privacy and /terms. Rerun after changing ebs/src/routes/legal.ts or the details below.
//
//   node --env-file=.env scripts/build-legal-pages.ts
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LEGAL_UPDATED, privacyHtml, termsHtml } from "../ebs/src/routes/legal.ts";

const extName = process.env.EXT_NAME || "Game Content Warnings (Unofficial)";
const operator = process.env.OPERATOR_NAME;
const contactEmail = process.env.CONTACT_EMAIL;
if (!operator || !contactEmail) throw new Error("Set OPERATOR_NAME and CONTACT_EMAIL (public details) in .env");

const deps = { extName, operator, contactEmail, updated: LEGAL_UPDATED };
const docs = resolve(import.meta.dirname, "../docs");
writeFileSync(`${docs}/privacy.html`, privacyHtml(deps));
writeFileSync(`${docs}/terms.html`, termsHtml(deps));
// GitHub Pages: serve files as-is (no Jekyll processing of the Markdown docs).
writeFileSync(`${docs}/.nojekyll`, "");
console.log("Wrote docs/privacy.html and docs/terms.html");
