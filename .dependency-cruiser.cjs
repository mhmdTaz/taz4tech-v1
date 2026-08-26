/**
 * Architecture enforcement for Taz4Tech.
 *
 * Four layers, dependencies point inward only:
 *
 *   src/app/       delivery      -> may use modules (barrel only), platform, ui
 *   src/modules/   domain logic  -> may use platform; cross-module via index.ts only
 *   src/platform/  primitives    -> may use nothing above it
 *   src/ui/        design system -> pure; may use platform tokens only
 *
 * Inside a module the same rule applies again:
 *   domain <- application <- infrastructure
 * The domain knows nothing. Infrastructure knows everything.
 */
module.exports = {
  forbidden: [
    // ---------------------------------------------------------------- layers
    {
      name: 'platform-is-the-floor',
      comment:
        'src/platform must not depend on app, modules or ui. It is the innermost ' +
        'layer: Result, money, ids, clock, config, logger. If platform needs a ' +
        'domain type, the type belongs in platform or the dependency is inverted.',
      severity: 'error',
      from: { path: '^src/platform/' },
      to: { path: '^src/(app|modules|ui|composition)/' },
    },
    {
      name: 'ui-is-pure',
      comment:
        'src/ui is the design system. It must not know about business modules or ' +
        'routing. Pass data in as props; do not fetch it.',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/(app|modules|composition)/' },
    },
    {
      name: 'modules-never-import-app',
      comment:
        'A module must not reach back into the Next.js delivery layer. If a module ' +
        'needs a request value, take it as a use-case parameter.',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^src/(app|composition)/' },
    },
    {
      name: 'modules-never-import-ui',
      comment:
        'Business modules must not import React components. Rendering is the ' + "app layer's job.",
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^src/ui/' },
    },

    // -------------------------------------------------- cross-module contract
    {
      name: 'cross-module-via-barrel-only',
      comment:
        'Module A may only see module B through src/modules/b/index.ts. Reaching ' +
        'into b/domain or b/infrastructure couples you to B internals and makes ' +
        'B unrefactorable. Export what you mean to share from the barrel.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: [
          '^src/modules/$1/', // own module: always fine
          '^src/modules/[^/]+/index[.]ts$', // another module's barrel: the sanctioned door
        ],
      },
    },
    {
      name: 'app-uses-module-barrels-only',
      comment:
        'Route handlers and pages import from src/modules/<name> (the barrel), ' +
        'never from its internals. This is what keeps delivery thin.',
      severity: 'error',
      from: { path: '^src/app/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: '^src/modules/[^/]+/index[.]ts$',
      },
    },

    {
      name: 'composition-uses-module-barrels-only',
      comment:
        'The composition root wires modules together, but it still only sees each ' +
        'module through its index.ts. A module builds its own adapters inside its ' +
        'createXModule() factory — composition passes in platform services and gets ' +
        'a ready module back. That is what stops this file from becoming a map of ' +
        'every internal file in the system.',
      severity: 'error',
      from: { path: '^src/composition/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: '^src/modules/[^/]+/index[.]ts$',
      },
    },
    {
      name: 'composition-is-wired-only-by-app',
      comment:
        'Only the delivery layer resolves the container. A module importing the ' +
        'composition root is a service locator, and it reintroduces every coupling ' +
        'the layering exists to prevent.',
      severity: 'error',
      from: { path: '^src/(modules|ui|platform)/' },
      to: { path: '^src/composition/' },
    },
    // ------------------------------------------------ intra-module direction
    {
      name: 'domain-knows-nothing',
      comment:
        'The domain layer is framework-free and IO-free. It may import platform ' +
        'primitives and its own siblings, nothing else. This is the layer that ' +
        'gets mutation-tested, so it must stay pure.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: { path: '^src/modules/[^/]+/(application|infrastructure)/' },
    },
    {
      name: 'application-does-not-touch-infrastructure',
      comment:
        'Use cases depend on ports (interfaces in contracts/), never on the Mongo ' +
        'adapter that implements them. The composition root wires the two together.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/application/' },
      to: { path: '^src/modules/[^/]+/infrastructure/' },
    },
    {
      name: 'no-db-driver-outside-infrastructure',
      comment:
        'The mongodb driver may only be imported by infrastructure adapters and the ' +
        'composition root. A domain file importing ObjectId is a design smell.',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot: '^src/(modules/[^/]+/infrastructure/|platform/mongo/)',
      },
      to: { dependencyTypes: ['npm'], path: '(^|/)node_modules/mongodb/' },
    },
    {
      name: 'no-next-inside-modules',
      comment:
        'next/* imports inside a module make its use cases untestable without the ' +
        'framework. Keep next in src/app.',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { dependencyTypes: ['npm'], path: '(^|/)node_modules/(next|react|react-dom)/' },
    },

    // --------------------------------------------------------------- hygiene
    {
      name: 'no-circular',
      comment: 'Circular imports break tree-shaking and make module init order load-bearing.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'A file nothing imports is either dead or a missing wire-up.',
      severity: 'error',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)[.][^/]+[.](js|cjs|mjs|ts|json)$',
          '[.]d[.]ts$',
          '(^|/)tsconfig[.]json$',
          '^src/app/',
          '^src/instrumentation[.]ts$',
          '^src/proxy[.]ts$',
        ],
      },
      to: {},
    },
    {
      name: 'no-dev-deps-in-src',
      comment: 'Shipping code must not import a devDependency; it will not exist in production.',
      severity: 'error',
      from: { path: '^src/', pathNot: '[.](test|spec)[.]ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys|util[.]promisify)$' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '([.]test[.]ts|[.]spec[.]ts|__tests__|[.]next)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
