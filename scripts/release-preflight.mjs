import { validateRelease } from "./release-policy.mjs";
import { main } from "./tooling.mjs";

main(() => {
  if (process.argv.length !== 2)
    throw new Error(
      "release:preflight no admite opciones ni autoriza publicaciones.",
    );
  console.log(JSON.stringify(validateRelease(), null, 2));
});
