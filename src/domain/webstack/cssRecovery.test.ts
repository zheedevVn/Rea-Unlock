import { describe, expect, it } from "vitest";

import { beautifyCss, recoverCss } from "./cssRecovery.js";

describe("recoverCss", () => {
  it("beautifies minified CSS and inventories selectors", () => {
    const recovered = recoverCss(
      ".a{color:red;margin:0}.b,.c:hover{background:url('x{y}.png');--brand:#fff}@media (max-width:600px){.a{display:none}}",
    );
    expect(recovered.ruleCount).toBe(4);
    expect(recovered.selectors).toContain(".a");
    expect(recovered.selectors).toContain(".b");
    expect(recovered.selectors).toContain(".c:hover");
    expect(recovered.atRules).toContain("@media");
    expect(recovered.customProperties).toContain("--brand");
    expect(recovered.beautified).toContain(".a {");
    expect(recovered.beautified).toContain("color: red;");
    expect(recovered.beautified).toContain("}");
  });

  it("keeps braces inside strings intact", () => {
    const beautified = beautifyCss(`.a{content:"{";}`);
    expect(beautified).toContain('content: "{";');
  });
});
