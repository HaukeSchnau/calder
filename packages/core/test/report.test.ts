import { describe, expect, it } from "@effect/vitest";
import { Report } from "../src/index.ts";

describe("Report", () => {
  it("parses JUnit", () => {
    const xml = `<?xml version="1.0"?>
<testsuites><testsuite name="api" tests="3">
  <testcase classname="api" name="adds &amp; stores" time="0.012"/>
  <testcase classname="api" name="times out" time="5.0"><failure message="Test timed out in 5000ms"/></testcase>
  <testcase classname="api" name="breaks" time="0.1" file="src/a.test.ts"><failure message="expected 1"><![CDATA[at a.test.ts:3 <x>]]></failure></testcase>
  <testcase classname="api" name="later"><skipped/></testcase>
</testsuite></testsuites>`;
    const results = Report.parseJUnit(xml);
    expect(results.map((r) => [r.name, r.status, r.durationMs])).toEqual([
      ["adds & stores", "passed", 12],
      ["times out", "timeout", 5000],
      ["breaks", "failed", 100],
      ["later", "skipped", 0],
    ]);
    expect(results[2]?.message).toBe("expected 1\nat a.test.ts:3 <x>");
    expect(Report.failures(results).map((f) => f._tag)).toEqual(["TestTimeout", "TestFailed"]);
  });
  it("parses vitest json", () => {
    const json = JSON.stringify({
      testResults: [
        {
          name: "/w/a.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: ["math"],
              title: "adds",
              status: "passed",
              duration: 3.4,
              failureMessages: [],
            },
            {
              ancestorTitles: ["math"],
              title: "divides",
              status: "failed",
              duration: 1,
              failureMessages: ["AssertionError: boom"],
            },
          ],
        },
        { name: "/w/b.test.ts", status: "failed", message: "SyntaxError", assertionResults: [] },
      ],
    });
    const results = Report.parseVitest(json);
    expect(results.map((r) => [r.suite, r.name, r.status])).toEqual([
      ["math", "adds", "passed"],
      ["math", "divides", "failed"],
      ["/w/b.test.ts", "(file)", "failed"],
    ]);
  });
});
