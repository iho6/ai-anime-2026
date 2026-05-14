import { createRequire } from "module";

const require = createRequire(import.meta.url);
const eslintConfigNext = require("eslint-config-next/core-web-vitals");

/** @type {import("eslint").Linter.Config[]} */
const config = [...eslintConfigNext];

export default config;
