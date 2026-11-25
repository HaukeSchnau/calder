// A stand-in for systemctl and for a host's sandbox command in agent-units.ts: `start --wait <unit>`
// and `run <pool> <job> <dir> <calder...>` act as the job's worker would, through the job's directory
// (under $FAKE_UNITS for a unit), and write what it found to $FAKE_OUT/<job>.json. Job 5709 runs until it
// is stopped, job 0b0b until $FAKE_OUT/go exists, and job 0c0c finds nothing. A call listed in
// $FAKE_OUT/fail fails once.
import { Effect } from "effect";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import * as Tunnel from "../../src/Tunnel.ts";

const [verb, ...rest] = process.argv.slice(2);
const out = process.env.FAKE_OUT!;
const call = [verb, ...rest].join(" ");

appendFileSync(join(out, "calls"), `${call}\n`);

const failing = existsSync(join(out, "fail"))
  ? readFileSync(join(out, "fail"), "utf8").split("\n")
  : [];

if (failing.includes(call)) {
  writeFileSync(join(out, "fail"), failing.filter((line) => line !== call).join("\n"));
  process.exit(1);
}

if (verb === "show") {
  console.log("0");
  process.exit(0);
}

if (verb !== "start" && verb !== "run") process.exit(0);

const unit = /^calder-job-(\w+)@(\w+)\.service$/.exec(rest.at(-1)!);

const [pool, job, dir] =
  verb === "run"
    ? (rest as [string, string, string])
    : [unit![1]!, unit![2]!, join(process.env.FAKE_UNITS!, unit![2]!)];

if (job === "0c0c") process.exit(0);

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

/** What the egress proxy answers to a CONNECT, on its socket. */
const connectVia = (socket: string, target: string) =>
  new Promise<string>((resolve) => {
    const client = connect(socket, () =>
      client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );

    client.once("data", (data) => {
      resolve(data.toString("latin1").split("\r\n")[0]!);
      client.destroy();
    });
  });

const found = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const socket = join(dir, "controller.sock");
      const bridge = yield* Tunnel.loopback(socket);
      const base = `http://127.0.0.1:${bridge.port}`;

      return yield* Effect.promise(async () => {
        const refs = await fetch(`${base}/git/app.git/info/refs?service=git-upload-pack`, {
          headers: { authorization: "Bearer j:t" },
        });

        const pack = await fetch(`${base}/git/app.git/git-upload-pack`, {
          method: "POST",
          body: "want 0123",
        });

        const rpc = await fetch(`${base}/rpc`);
        const agent = await fetch(`${base}/agent`);

        const echoed = await new Promise<string>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/worker`);
          ws.onopen = () => ws.send("hello");
          ws.onmessage = (event) => {
            resolve(String(event.data));
            ws.close();
          };
        });

        const egressSocket = join(dir, "egress.sock");

        const egress = existsSync(egressSocket)
          ? await connectVia(egressSocket, "example.org:443")
          : null;

        const listed = existsSync(egressSocket)
          ? await connectVia(egressSocket, `localhost:${process.env.FAKE_PORT}`)
          : null;

        return {
          pool,
          modes: { dir: mode(dir), token: mode(join(dir, "token")), controller: mode(socket) },
          token: readFileSync(join(dir, "token"), "utf8"),
          refs: `${refs.status} ${await refs.text()}`,
          pack: `${pack.status} ${await pack.text()}`,
          rpc: rpc.status,
          agent: agent.status,
          echoed,
          egress,
          listed,
        };
      });
    }),
  ),
);

writeFileSync(join(out, `${job}.json`), JSON.stringify(found));

if (job === "5709") await new Promise(() => {});

while (job === "0b0b" && !existsSync(join(out, "go")))
  await new Promise((resolve) => setTimeout(resolve, 20));
