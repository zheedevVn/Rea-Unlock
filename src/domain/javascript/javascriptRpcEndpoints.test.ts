import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const endpoints = (source: string) =>
  analyzeJavaScriptStaticSource(source).endpoints.map(
    ({ kind, value, mechanism }) => ({ kind, value, mechanism }),
  );

const rpcEndpoints = (source: string) =>
  endpoints(source).filter(
    ({ mechanism }) =>
      mechanism.startsWith("trpc:") || mechanism.startsWith("graphql:"),
  );

describe("RPC object property ownership", () => {
  it.each([
    ['url: "/trpc/old", url: "/trpc/live"', "/trpc/live"],
    ['url: "/trpc/old", url: runtimeUrl', null],
    ['url: "/trpc/old", ...options', null],
    ['url: "/trpc/old", [key]: runtimeUrl', null],
    ['url: "/trpc/old", get url() { return runtimeUrl; }', null],
    ['url: "/trpc/old", url() {}', null],
    ['...options, url: "/trpc/live", headers: {}', "/trpc/live"],
    ['[key]: runtimeUrl, url: "/trpc/live"', "/trpc/live"],
    ['url: "/trpc/old", ["url"]: "/trpc/live"', "/trpc/live"],
    ['url: "/trpc/old", [`url`]: "/trpc/live"', "/trpc/live"],
    ['url: "/trpc/live", [`headers`]: {}', "/trpc/live"],
    ['url: "/trpc/live", [1n]: {}', "/trpc/live"],
    ['url: "/trpc/live", [0x1n]: {}', "/trpc/live"],
    ['url: "/trpc/live", [0b1n]: {}', "/trpc/live"],
    ['url: "/trpc/live", [-1n]: {}', "/trpc/live"],
  ] as const)(
    "reads only the final known link URL from {%s}",
    (options, value) => {
      expect(rpcEndpoints(`httpBatchLink({ ${options} });`)).toEqual(
        value === null
          ? []
          : [{ kind: "network", value, mechanism: "trpc:link:httpBatchLink" }],
      );
    },
  );

  it.each([
    ['operation: "mutation"', "Old", "graphql:mutation"],
    ['name: { kind: "Name", value: "Current" }', "Current", "graphql:query"],
    ['kind: "FragmentDefinition"', null, null],
    ["name: runtimeName", null, null],
    ["get name() { return runtimeName; }", null, null],
    ["...options", null, null],
    ["[key]: runtimeValue", null, null],
  ] as const)(
    "honors final GraphQL document properties: %s",
    (override, value, mechanism) => {
      const source = `const doc = {
      kind: "OperationDefinition", operation: "query",
      name: { kind: "Name", value: "Old" }, ${override}
    };`;
      expect(rpcEndpoints(source)).toEqual(
        value === null ? [] : [{ kind: "network", value, mechanism }],
      );
    },
  );
});

describe("tRPC procedure recognition", () => {
  it("recognizes React hook procedures on a renamed proxy root", () => {
    expect(
      rpcEndpoints(`
        const a = n.post.byId.useQuery({ id: 1 });
        const b = n.post.add.useMutation();
        n.feed.useInfiniteQuery({ limit: 10 });
        n.onEvent.useSubscription(undefined, { onData() {} });
        n.invoice.list.useSuspenseQuery();
      `),
    ).toEqual([
      {
        kind: "network",
        value: "post.byId",
        mechanism: "trpc:procedure:useQuery",
      },
      {
        kind: "network",
        value: "post.add",
        mechanism: "trpc:procedure:useMutation",
      },
      {
        kind: "network",
        value: "feed",
        mechanism: "trpc:procedure:useInfiniteQuery",
      },
      {
        kind: "network",
        value: "onEvent",
        mechanism: "trpc:procedure:useSubscription",
      },
      {
        kind: "network",
        value: "invoice.list",
        mechanism: "trpc:procedure:useSuspenseQuery",
      },
    ]);
  });

  it("recognizes TanStack React Query integration option factories", () => {
    expect(
      rpcEndpoints(`
        useQuery(e.invoice.list.queryOptions({ page: 1 }));
        useMutation(e.invoice.create.mutationOptions());
        client.invalidateQueries({ queryKey: e.invoice.list.queryKey() });
      `),
    ).toEqual([
      {
        kind: "network",
        value: "invoice.list",
        mechanism: "trpc:procedure:queryOptions",
      },
      {
        kind: "network",
        value: "invoice.create",
        mechanism: "trpc:procedure:mutationOptions",
      },
    ]);
  });

  it("recognizes vanilla client calls and link URLs only in sources carrying a tRPC marker", () => {
    expect(
      rpcEndpoints(`
        const client = createTRPCClient({
          links: [httpBatchLink({ url: "/api/trpc" })],
        });
        const bilbo = await client.getUser.query("id_bilbo");
        await client.post.add.mutate({ title: "x" });
        client.onPost.subscribe(undefined, { onData() {} });
      `),
    ).toEqual([
      {
        kind: "network",
        value: "/api/trpc",
        mechanism: "trpc:link:httpBatchLink",
      },
      { kind: "network", value: "getUser", mechanism: "trpc:procedure:query" },
      {
        kind: "network",
        value: "post.add",
        mechanism: "trpc:procedure:mutate",
      },
      {
        kind: "network",
        value: "onPost",
        mechanism: "trpc:procedure:subscribe",
      },
    ]);
    expect(
      rpcEndpoints(`
        const rows = await pool.users.query("select 1");
        emitter.changes.subscribe(listener);
        store.cart.mutate(update);
      `),
    ).toEqual([]);
  });

  it("requires corroboration for request methods shared with Apollo, RxJS and stores", () => {
    // The source carries a tRPC marker, so only the call shape can decide.
    expect(
      rpcEndpoints(`
        class TRPCClientError extends Error {}
        this.client.query({ query: q });
        e.queryManager.query(options);
        this.untypedClient.query("path", input);
        this.route.params.subscribe((params) => params);
        t.current.subscribe(listener);
        r.store.subscribe(() => {});
        n.cache.mutate(update);
        o.k.endpoints.getPosts.useQuery();
        e.api.endpoints.list.useQuery();
        this.trpc.invoice.list.useQuery();
      `),
    ).toEqual([]);
    expect(
      rpcEndpoints(`
        class TRPCClientError extends Error {}
        e.invoice.list.query({ page: 1 });
        e.invoice.onChange.subscribe(undefined, { onData() {} });
      `),
    ).toEqual([
      {
        kind: "network",
        value: "invoice.list",
        mechanism: "trpc:procedure:query",
      },
      {
        kind: "network",
        value: "invoice.onChange",
        mechanism: "trpc:procedure:subscribe",
      },
    ]);
  });

  it("never reports browser globals or RTK Query endpoints as procedures", () => {
    expect(
      rpcEndpoints(`
        class TRPCClientError extends Error {}
        navigator.permissions.query({ name: "geolocation" });
        window.navigator.permissions.query({ name: "camera" });
        api.endpoints.getPosts.useQuery();
        api.useGetPostsQuery();
        useQuery({ queryKey: ["x"] });
      `),
    ).toEqual([]);
  });
});

describe("tRPC binding identity and bundled syntax", () => {
  it("keeps client bindings local to their lexical declaration", () => {
    expect(
      rpcEndpoints(`
      function first() { const c = createTRPCClient({}); c.users.query(); }
      function unrelated(c) { c.users.query("select 1"); }
      const c = createTRPCClient({});
      function closure() { c.posts.query(); }
      function shadowed() { c.users.query(); var c = pool; }
      { const c = pool; c.users.query(); }
      try {} catch (c) { c.users.query(); }
    `),
    ).toEqual([
      { kind: "network", value: "users", mechanism: "trpc:procedure:query" },
      { kind: "network", value: "posts", mechanism: "trpc:procedure:query" },
    ]);
  });

  it("does not corroborate overwritten or destructured client bindings", () => {
    expect(
      rpcEndpoints(`
      let c = createTRPCClient({}); c = pool; c.users.query();
      const { client } = createTRPCClient({}); client.users.query();
    `),
    ).toEqual([]);
    expect(
      rpcEndpoints(`
      var c = createTRPCClient({}); c.users.query();
    `),
    ).toEqual([
      { kind: "network", value: "users", mechanism: "trpc:procedure:query" },
    ]);
  });

  it("retains one client initializer across variable redeclarations", () => {
    expect(
      rpcEndpoints(`
      var c;
      var c = createTRPCClient({});
      var c;
      c.users.query();

      var replaced;
      var replaced = createTRPCClient({});
      replaced = pool;
      replaced.posts.query();

      var initializedTwice = createTRPCClient({});
      var initializedTwice = pool;
      initializedTwice.comments.query();

      var conditional;
      if (flag) { var conditional = createTRPCClient({}); }
      conditional.groups.query();
    `),
    ).toEqual([
      { kind: "network", value: "users", mechanism: "trpc:procedure:query" },
    ]);
  });

  it("recognizes surviving factory names inside bundled call wrappers", () => {
    expect(
      rpcEndpoints(`
      const c = (0, t.createTRPCClient)({
        links: [(0, t.httpBatchLink)({ url: "/api/rpc" })],
      });
      c.users.query();
      const p = (t.createTRPCProxyClient as any)({});
      p.posts.query();
      (0, t.httpLink)({ url: "/api/other" });
    `),
    ).toEqual([
      {
        kind: "network",
        value: "/api/rpc",
        mechanism: "trpc:link:httpBatchLink",
      },
      { kind: "network", value: "users", mechanism: "trpc:procedure:query" },
      { kind: "network", value: "posts", mechanism: "trpc:procedure:query" },
      { kind: "network", value: "/api/other", mechanism: "trpc:link:httpLink" },
    ]);
  });

  it("preserves procedure paths beyond the former nesting cutoff", () => {
    const path = Array.from({ length: 64 }, (_, i) => `router${i}`).join(".");
    expect(rpcEndpoints(`root.${path}.useQuery();`)).toEqual([
      { kind: "network", value: path, mechanism: "trpc:procedure:useQuery" },
    ]);
  });
});

describe("GraphQL operation recognition", () => {
  it("recognizes named operations in tagged templates and string literals", () => {
    expect(
      rpcEndpoints(`
        const GET_USER = gql\`
          # comment
          query GetUser($id: ID!) { user(id: $id) { name } }
        \`;
        const UPDATE = "mutation UpdateInvoice($input: InvoiceInput!) { updateInvoice(input: $input) { id } }";
        const ON = \`subscription OnInvoice { invoiceChanged { id } } \${fragment}\`;
      `),
    ).toEqual([
      { kind: "network", value: "GetUser", mechanism: "graphql:query" },
      {
        kind: "network",
        value: "UpdateInvoice",
        mechanism: "graphql:mutation",
      },
      {
        kind: "network",
        value: "OnInvoice",
        mechanism: "graphql:subscription",
      },
    ]);
  });

  it("recognizes operations after leading fragment interpolations only when prior quasis are ignored", () => {
    expect(
      rpcEndpoints(`
        const one = gql\`  \${CORE_FIELDS}
          query CommentsForPost($postId: ID!) { comments { id } }\`;
        const two = gql\`\${CORE_FIELDS}
          # another fragment
          ,\${MORE_FIELDS}
          mutation UpdatePost($id: ID!) { updatePost(id: $id) { id } }\`;
        const prose = gql\`fragment prose before interpolation
          \${CORE_FIELDS}
          query NotAnOperation { viewer { id } }\`;
      `),
    ).toEqual([
      { kind: "network", value: "CommentsForPost", mechanism: "graphql:query" },
      { kind: "network", value: "UpdatePost", mechanism: "graphql:mutation" },
    ]);
  });

  it.each([
    ["query", "query # header\nGetUser { user }"],
    ["mutation", "mutation,# header\r\nGetUser { user }"],
    ["subscription", "subscription# header\rGetUser { user }"],
    ["query", "query GetUser # selection\n{ user }"],
    ["query", "query GetUser { # field\nuser }"],
    ["query", "query GetUser( # variable\n$id: ID!) { user }"],
    ["query", "query GetUser # directive\n@skip(if: false) { user }"],
    ["query", "query GetUser @ # directive name\nkeep { user }"],
    [
      "query",
      "# prefix\nquery # one\n, # two\nGetUser # three\n{ # four\nuser }",
    ],
  ])("recognizes %s header comments in %s", (type, text) => {
    const expected = [
      { kind: "network", value: "GetUser", mechanism: `graphql:${type}` },
    ];
    expect(rpcEndpoints(`const doc = ${JSON.stringify(text)};`)).toEqual(
      expected,
    );
    expect(rpcEndpoints("const doc = gql`" + text + "`; ")).toEqual(expected);
  });

  it.each([
    "query # GetUser { user }",
    "query GetUser # { user }",
    "query GetUser { # user }",
    "query # anonymous\n{ user }",
    "query GetUser # prose\nparameters",
    "query Get# split name\nUser { user }",
    "query GetUser @ # missing directive name",
    "query GetUser { # fragment\n...UserFields }",
    "query\u00a0GetUser { user }",
    "query\vGetUser { user }",
  ])("keeps incomplete or unsupported header text unknown: %s", (text) => {
    expect(rpcEndpoints(`const doc = ${JSON.stringify(text)};`)).toEqual([]);
  });

  it("retains operations after long ignored prefixes and long headers", () => {
    const name = "Operation" + "x".repeat(512);
    const text =
      "#" +
      "comment".repeat(700) +
      "\nquery " +
      name +
      " ".repeat(600) +
      "{ users { id } }";
    expect(rpcEndpoints(`const doc = ${JSON.stringify(text)};`)).toEqual([
      { kind: "network", value: name, mechanism: "graphql:query" },
    ]);
  });
});

describe("GraphQL document ownership", () => {
  it("recognizes precompiled GraphQL document objects", () => {
    expect(
      rpcEndpoints(`
        const doc = { kind: "Document", definitions: [{
          kind: "OperationDefinition",
          operation: "query",
          name: { kind: "Name", value: "ListInvoices" },
          selectionSet: { kind: "SelectionSet", selections: [] },
        }] };
      `),
    ).toEqual([
      { kind: "network", value: "ListInvoices", mechanism: "graphql:query" },
    ]);
  });

  it("ignores anonymous operations and ordinary prose", () => {
    expect(
      rpcEndpoints(`
        const a = "query { viewer { id } }";
        const b = "query string parameters";
        const c = "mutation observer started";
        const d = { kind: "OperationDefinition", operation: "query" };
        const e = "mutation Observer {";
        const f = "query Search(";
        const g = "subscription Plan (monthly)";
      `),
    ).toEqual([]);
  });

  it("reports a precompiled graphql-tag document once, not again from loc.source.body", () => {
    expect(
      rpcEndpoints(`
        const doc = { kind: "Document", definitions: [{
          kind: "OperationDefinition",
          operation: "query",
          name: { kind: "Name", value: "GetUser" },
          selectionSet: { kind: "SelectionSet", selections: [] },
        }], loc: { start: 0, end: 40, source: {
          body: "query GetUser($id: ID!) { user(id: $id) { name } }",
          name: "GraphQL request",
          locationOffset: { line: 1, column: 1 },
        } } };
      `),
    ).toEqual([
      { kind: "network", value: "GetUser", mechanism: "graphql:query" },
    ]);
  });

  it.each([
    `body: "query Old { user }", body: "query Current { user }", locationOffset: { line: 1, column: 1 }`,
    `body: "query Old { user }", locationOffset: { line: 1, column: 1 }, ...sourceOptions`,
    `body: "query Old { user }", locationOffset: { line: 1, column: 1 }, ...{ body: "query Current { user }" }`,
    `...{ body: "query Old { user }" }, ...runtimeOptions, locationOffset: { line: 1, column: 1 }`,
  ])(
    "does not report overwritten or uncertain GraphQL source bodies: %s",
    (sourceFields) => {
      expect(
        rpcEndpoints(`
          const source = { ${sourceFields} };
          const operation = {
            kind: "OperationDefinition",
            operation: "query",
            name: { kind: "Name", value: "Current" },
            loc: { source },
          };
        `),
      ).toEqual([
        { kind: "network", value: "Current", mechanism: "graphql:query" },
      ]);
    },
  );

  it("keeps ordinary GraphQL string scans outside Source-shaped objects", () => {
    expect(rpcEndpoints('const text = "query Standalone { user }";')).toEqual([
      { kind: "network", value: "Standalone", mechanism: "graphql:query" },
    ]);
  });
});

it("keeps existing network endpoint recognition unchanged", () => {
  expect(
    endpoints(`fetch("/api/invoices"); n.invoice.list.useQuery();`),
  ).toEqual([
    { kind: "network", value: "/api/invoices", mechanism: "call:fetch" },
    {
      kind: "network",
      value: "invoice.list",
      mechanism: "trpc:procedure:useQuery",
    },
  ]);
});
