import type { parser } from '@renovatebot/good-enough-parser';
import { lang, query as q } from '@renovatebot/good-enough-parser';
import upath from 'upath';
import { logger } from '../../../logger/index.ts';
import { readLocalFile } from '../../../util/fs/index.ts';
import { newlineRegex, regEx } from '../../../util/regex.ts';
import { parseUrl } from '../../../util/url.ts';
import { GithubReleasesDatasource } from '../../datasource/github-releases/index.ts';
import { MAVEN_REPO } from '../../datasource/maven/common.ts';
import { MavenDatasource } from '../../datasource/maven/index.ts';
import { SbtPackageDatasource } from '../../datasource/sbt-package/index.ts';
import {
  SBT_PLUGINS_REPO,
  SbtPluginDatasource,
} from '../../datasource/sbt-plugin/index.ts';
import { get } from '../../versioning/index.ts';
import * as mavenVersioning from '../../versioning/maven/index.ts';
import * as semverVersioning from '../../versioning/semver/index.ts';
import type {
  ExtractConfig,
  PackageDependency,
  PackageFile,
  PackageFileContent,
} from '../types.ts';
import { normalizeScalaVersion, sortPackageFiles } from './util.ts';

type Vars = Record<string, string>;

// Raw definitions collected in the first pass, before any alias resolution.
export interface CollectedTable {
  // Literal values, registered under BOTH the bare key and, inside a named
  // object/trait scope, the fully-qualified dotted key (e.g. `avro` AND
  // `Version.avro`), exactly as the current single-pass extractor does.
  vals: Vars;
  // Bare alias key -> unresolved target key (bare or dotted). The target is
  // not required to exist yet, which makes forward references resolvable.
  aliases: Vars;
}

// Folds `aliases` into `vals` to a fixpoint, returning a flat map from every
// resolvable key to its literal value. Pure and total: it never mutates its
// input, never throws, and always terminates (cycles are broken via a
// per-chain visited set). A missing target or a cycle leaves the alias key
// unresolved (omitted from the output).
export function resolve(table: CollectedTable): Vars {
  const resolved: Vars = { ...table.vals };
  for (const aliasKey of Object.keys(table.aliases)) {
    const visited = new Set<string>([aliasKey]);
    let current = table.aliases[aliasKey];
    let value: string | undefined;
    for (;;) {
      if (visited.has(current)) {
        // Revisited key: cyclic chain, leave unresolved.
        break;
      }
      if (Object.hasOwn(table.vals, current)) {
        value = table.vals[current];
        break;
      }
      if (Object.hasOwn(table.aliases, current)) {
        visited.add(current);
        current = table.aliases[current];
        continue;
      }
      // Missing target: leave unresolved.
      break;
    }
    if (value !== undefined) {
      resolved[aliasKey] = value;
    }
  }
  return resolved;
}

// Pass-1 context: records raw value/alias definitions only. Carries no
// emission (dep) state and no import/mixin scoping — those are structural and
// re-derived per file in pass 2.
interface CollectCtx {
  vals: Vars;
  aliases: Vars;

  // Stack of enclosing `object`/`trait` names, used to build fully-qualified
  // dotted keys for members declared inside named objects/traits. Pushed and
  // popped immutably so the stack stays balanced even when the parser discards
  // a match-less body via the zero-match `return null` path.
  objectScope?: string[];

  currentVarName?: string;
  // Temporary dotted key built while parsing an alias RHS
  // (e.g. `Version.avro` in `val avroVersion = Version.avro`).
  currentAliasKey?: string;
  // Temporary object name while parsing anonymous `new { … }` structs.
  currentObjectName?: string;
}

// Pass-2 context: emits dependencies against the pre-resolved `resolvedVars`
// table. Value lookups read `resolvedVars`; the pass builds no value table.
interface EmitCtx {
  resolvedVars: Vars;
  deps: PackageDependency[];
  registryUrls: string[];

  scalaVersion?: string;
  packageFileVersion?: string;

  groupId?: string;
  artifactId?: string;
  currentValue?: string;

  currentVarName?: string;
  // Temporary dotted path built while parsing a wildcard `import` statement.
  currentImportPath?: string;
  depType?: string;
  useScalaVersion?: boolean;
  variableName?: string;

  // Use to contain temporary object name
  // when parsing anonymous object structs.
  currentObjectName?: string;

  // Object paths brought into scope by a wildcard import
  // (`import Version.*` / `import Version._`), e.g. `['Version']`. A bare
  // reference that misses `resolvedVars` is retried as `${importPath}.${name}`.
  imports?: string[];

  // Bare member name -> fully-qualified dotted key, populated when an object
  // mixes in a trait (`object Dependencies extends Version`). Lets a bare
  // reference (e.g. `avro`) inside the object resolve to the inherited
  // member's value and report the qualified `sharedVariableName`
  // (`Version.avro`).
  qualifiedAliases?: Record<string, string>;

  // Stack of `qualifiedAliases` snapshots saved on entering each
  // `object`/`trait` body and restored on exit, so trait mixins seeded by
  // `extends` do not leak into sibling scopes.
  savedAliases?: (Record<string, string> | undefined)[];
}

const scala = lang.createLang('scala');

const sbtVersionRegex = regEx(
  'sbt\\.version *= *(?<version>\\d+\\.\\d+\\.\\d+)',
);

const sbtProxyUrlRegex = regEx(
  /^\s*(?<repoName>\S+):\s+(?<proxy>https?:\/\/[\w./-]+)/,
);

// ---------------------------------------------------------------------------
// Pass 1 — collection matchers (definition-side only).
// Record raw `val`/alias/object-field definitions. No dep emission, no value
// resolution, no import/mixin tracking.
// ---------------------------------------------------------------------------

const collectVariableNameMatch = q
  .sym<CollectCtx>((ctx, { value: currentVarName }) => ({
    ...ctx,
    currentVarName,
  }))
  .opt(q.op<CollectCtx>(':').sym('String'));

const collectVariableValueMatch = q.str<CollectCtx>((ctx, { value }) => {
  const name = ctx.currentVarName!;
  // Always register the bare key so same-scope references (and top-level
  // `val`s) resolve. Inside a named object/trait scope, also register the
  // fully-qualified dotted key (e.g. `Version.avro`) so qualified references
  // resolve and report the dotted `sharedVariableName`.
  ctx.vals[name] = value;
  if (ctx.objectScope?.length) {
    ctx.vals[`${ctx.objectScope.join('.')}.${name}`] = value;
  }
  delete ctx.currentVarName;
  return ctx;
});

const collectAssignmentMatch = q
  .sym<CollectCtx>('val')
  .join(collectVariableNameMatch)
  .op('=');

// Records `val <alias> = <symbol|dotted-symbol>` as an unresolved
// `aliases[aliasKey] = targetKey` mapping. The target is NOT required to exist
// yet — `resolve()` folds the chain afterwards, so forward references and
// chained aliases resolve regardless of declaration order. Bare alias key only
// (aliases are declared at the root level, never qualified).
const collectAliasValueMatch = q
  .sym<CollectCtx>((ctx, { value: currentAliasKey }) => ({
    ...ctx,
    currentAliasKey,
  }))
  .many(
    q.op<CollectCtx>('.').sym((ctx, { value: varName }) => ({
      ...ctx,
      currentAliasKey: `${ctx.currentAliasKey}.${varName}`,
    })),
    0,
    32,
  )
  .handler((ctx) => {
    ctx.aliases[ctx.currentVarName!] = ctx.currentAliasKey!;
    delete ctx.currentVarName;
    delete ctx.currentAliasKey;
    return ctx;
  });

const collectAliasDefinitionMatch = q
  .alt(
    q.sym<CollectCtx>('lazy').join(collectAssignmentMatch),
    collectAssignmentMatch,
  )
  .join(collectAliasValueMatch);

const collectVariableDefinitionMatch = q
  .alt(
    q.sym<CollectCtx>('lazy').join(collectAssignmentMatch),
    collectAssignmentMatch,
    collectVariableNameMatch.op(':='),
  )
  .join(collectVariableValueMatch);

const collectObjectFieldMatch = q
  .sym<CollectCtx>((ctx, { value: fieldName }) => ({
    ...ctx,
    currentVarName: `${ctx.currentObjectName}.${fieldName}`,
  }))
  .op('=')
  .str((ctx, { value }) => {
    ctx.vals[ctx.currentVarName!] = value;
    delete ctx.currentVarName;
    return ctx;
  });

const collectObjectAssignmentMatch = q
  .sym<CollectCtx>('val')
  .sym((ctx, { value: currentObjectName }) => ({
    ...ctx,
    currentObjectName,
  }))
  .op('=')
  .sym('new')
  .tree({
    search: q.many(collectObjectFieldMatch),
  })
  .handler((ctx) => {
    delete ctx.currentObjectName;
    return ctx;
  });

// Maintains the `objectScope` stack so inner `val`s register under dotted keys.
// `extends`/`import` are structural and NOT processed in pass 1; the `extends`
// clause is consumed (but ignored) so the trailing body tree still matches.
function collectObjectScopeMatch(
  search: q.QueryBuilder<CollectCtx, parser.Node>,
): q.QueryBuilder<CollectCtx, parser.Node> {
  return q
    .sym<CollectCtx>(regEx(/^(?:object|trait)$/))
    .sym((ctx, { value: name }) => ({
      ...ctx,
      objectScope: [...(ctx.objectScope ?? []), name],
    }))
    .opt(q.sym<CollectCtx>('extends').sym())
    .tree({
      type: 'wrapped-tree',
      maxDepth: 32,
      startsWith: '{',
      endsWith: '}',
      search,
      postHandler: (ctx) => ({
        ...ctx,
        objectScope: ctx.objectScope?.slice(0, -1),
      }),
    });
}

const collectNestedObjectDefinitionMatch = collectObjectScopeMatch(
  collectVariableDefinitionMatch,
);

const collectObjectDefinitionMatch = collectObjectScopeMatch(
  q.alt<CollectCtx>(
    collectVariableDefinitionMatch,
    collectObjectAssignmentMatch,
    collectNestedObjectDefinitionMatch,
  ),
);

const collectQuery = q.tree<CollectCtx>({
  type: 'root-tree',
  maxDepth: 32,
  search: q.alt<CollectCtx>(
    collectVariableDefinitionMatch,
    collectObjectAssignmentMatch,
    collectAliasDefinitionMatch,
    collectObjectDefinitionMatch,
  ),
});

// ---------------------------------------------------------------------------
// Pass 2 — emission matchers.
// Mirrors the historic walker (including `imports`,
// `qualifiedAliases`/`savedAliases`) so reported names and scoping stay
// identical. The only change: value lookups read the pre-resolved
// `resolvedVars` instead of building a table mid-walk, so the definition-side
// matchers are consume-only.
// ---------------------------------------------------------------------------

const scalaVersionMatch = q
  .sym<EmitCtx>('scalaVersion')
  .op(':=')
  .alt(
    // Dotted symbol. Important to have this first in the `alt` as otherwise
    // the tree walker will eager parse a simple symbol and stop there.
    // Consumes `.op('.').sym()` repeatedly to support arbitrary nesting
    // depth (e.g. `Version.ZIO.json`). The lookup runs only once, on the
    // fully-built dotted key, so an intermediate path that happens to exist
    // in `resolvedVars` cannot shadow an unresolvable longer path.
    q
      // keep the first part of the path in context
      .sym<EmitCtx>((ctx, { value: currentVarName }) => ({
        ...ctx,
        currentVarName,
      }))
      .many(
        q.op<EmitCtx>('.').sym((ctx, { value: varName }) => ({
          ...ctx,
          currentVarName: `${ctx.currentVarName}.${varName}`,
        })),
        1,
        32,
      )
      .handler((ctx) => {
        const dottedVariableName = ctx.currentVarName!;
        const currentValue = ctx.resolvedVars[dottedVariableName];
        const next = { ...ctx };
        if (currentValue) {
          next.scalaVersion = currentValue;
        }
        delete next.currentVarName;
        return next;
      }),
    // Simple symbol defined previously
    q.sym<EmitCtx>((ctx, { value: varName }) => {
      const scalaVersion = ctx.resolvedVars[varName];
      if (scalaVersion) {
        ctx.scalaVersion = scalaVersion;
      }
      return ctx;
    }),
    // Direct string
    q.str<EmitCtx>((ctx, { value: scalaVersion }) => ({
      ...ctx,
      scalaVersion,
    })),
  )
  .handler((ctx) => {
    if (ctx.scalaVersion) {
      const version = get(mavenVersioning.id);

      let packageName = 'org.scala-lang:scala-library';
      if (version.getMajor(ctx.scalaVersion) === 3) {
        packageName = 'org.scala-lang:scala3-library_3';
      }

      const dep: PackageDependency = {
        datasource: MavenDatasource.id,
        depName: 'scala',
        packageName,
        currentValue: ctx.scalaVersion,
        separateMinorPatch: true,
      };
      ctx.scalaVersion = normalizeScalaVersion(ctx.scalaVersion);
      ctx.deps.push(dep);
    }
    return ctx;
  });

const packageFileVersionMatch = q
  .sym<EmitCtx>('version')
  .op(':=')
  .alt(
    q.str<EmitCtx>((ctx, { value: packageFileVersion }) => ({
      ...ctx,
      packageFileVersion,
    })),
    q.sym<EmitCtx>((ctx, { value: varName }) => {
      const packageFileVersion = ctx.resolvedVars[varName];
      if (packageFileVersion) {
        ctx.packageFileVersion = packageFileVersion;
      }
      return ctx;
    }),
  );

const variableNameMatch = q
  .sym<EmitCtx>((ctx, { value: currentVarName }) => ({
    ...ctx,
    currentVarName,
  }))
  .opt(q.op<EmitCtx>(':').sym('String'));

// Consume-only in pass 2: values already live in `resolvedVars`.
const variableValueMatch = q.str<EmitCtx>((ctx) => {
  delete ctx.currentVarName;
  return ctx;
});

const assignmentMatch = q.sym<EmitCtx>('val').join(variableNameMatch).op('=');

// Consume-only alias RHS in pass 2 (bare or dotted symbol). Resolution already
// happened in `resolve()`, so this only advances the walker.
const aliasValueMatch = q
  .sym<EmitCtx>()
  .many(q.op<EmitCtx>('.').sym(), 0, 32)
  .handler((ctx) => {
    delete ctx.currentVarName;
    return ctx;
  });

const aliasDefinitionMatch = q
  .alt(q.sym<EmitCtx>('lazy').join(assignmentMatch), assignmentMatch)
  .join(aliasValueMatch);

const variableDefinitionMatch = q
  .alt(
    q.sym<EmitCtx>('lazy').join(assignmentMatch),
    assignmentMatch,
    variableNameMatch.op(':='),
  )
  .join(variableValueMatch);

// Consume-only anonymous-object field in pass 2.
const objectFieldMatch = q
  .sym<EmitCtx>((ctx, { value: fieldName }) => ({
    ...ctx,
    currentVarName: `${ctx.currentObjectName}.${fieldName}`,
  }))
  .op('=')
  .str((ctx) => {
    delete ctx.currentVarName;
    return ctx;
  });

const objectAssignmentMatch = q
  .sym<EmitCtx>('val')
  .sym((ctx, { value: currentObjectName }) => ({
    ...ctx,
    currentObjectName,
  }))
  .op('=')
  .sym('new')
  .tree({
    search: q.many(objectFieldMatch),
  })
  .handler((ctx) => {
    delete ctx.currentObjectName;
    return ctx;
  });

// Matches `object <Name> { ... }` and `trait <Name> { ... }`, maintaining the
// `qualifiedAliases`/`savedAliases` mixin scope.
function extendsHandler(
  ctx: EmitCtx,
  { value: traitName }: { value: string },
): EmitCtx {
  // Resolves against members already present in `resolvedVars`. The trailing
  // `.` guards against prefix collisions (`Version.` must not match
  // `VersionFoo.x`).
  const prefix = `${traitName}.`;
  const qualifiedAliases = { ...ctx.qualifiedAliases };
  for (const key of Object.keys(ctx.resolvedVars)) {
    if (key.startsWith(prefix)) {
      qualifiedAliases[key.slice(prefix.length)] = key;
    }
  }
  return { ...ctx, qualifiedAliases };
}

function objectScopeMatch(
  search: q.QueryBuilder<EmitCtx, parser.Node>,
): q.QueryBuilder<EmitCtx, parser.Node> {
  return (
    q
      .sym<EmitCtx>(regEx(/^(?:object|trait)$/))
      .sym((ctx) => ({
        ...ctx,
        // Snapshot the current aliases so `extends`-seeded entries can be
        // restored on exit and do not leak into sibling scopes.
        savedAliases: [...(ctx.savedAliases ?? []), ctx.qualifiedAliases],
      }))
      // `object Dependencies extends Version`: seed `qualifiedAliases` from the
      // trait's already-registered dotted members (e.g. `Version.avro`) so bare
      // references inside the object resolve to the inherited member. Only a
      // single mixin is matched; `extends A with B` resolves via `A` only.
      .opt(q.sym<EmitCtx>('extends').sym(extendsHandler))
      .tree({
        type: 'wrapped-tree',
        maxDepth: 32,
        startsWith: '{',
        endsWith: '}',
        search,
        postHandler: (ctx) => {
          // `savedAliases` is always seeded by the object/trait name handler
          // above before this tree's `postHandler` runs.
          const savedAliases = ctx.savedAliases!;
          return {
            ...ctx,
            qualifiedAliases: savedAliases[savedAliases.length - 1],
            savedAliases: savedAliases.slice(0, -1),
          };
        },
      })
  );
}

// Matches a wildcard import `import <Path>.*` / `import <Path>._` and records
// the imported object path in `ctx.imports`. Selective/renamed imports are out
// of scope and are not matched (the mandatory `.* ` / `._` suffix excludes
// `import Version.avro`).
const importMatch = q
  .sym<EmitCtx>('import')
  .sym((ctx, { value: currentImportPath }) => ({ ...ctx, currentImportPath }))
  .many(
    q.op<EmitCtx>('.').sym((ctx, { value: segment }) => ({
      ...ctx,
      currentImportPath: `${ctx.currentImportPath}.${segment}`,
    })),
    0,
    32,
  )
  .alt(q.op<EmitCtx>('.').op('*'), q.op<EmitCtx>('.').sym('_'))
  .handler((ctx) => {
    const next = {
      ...ctx,
      imports: [...(ctx.imports ?? []), ctx.currentImportPath!],
    };
    delete next.currentImportPath;
    return next;
  });

const groupIdMatch = q.alt<EmitCtx>(
  q.sym<EmitCtx>((ctx, { value: varName }) => {
    const currentGroupId = ctx.resolvedVars[varName];
    if (currentGroupId) {
      ctx.groupId = currentGroupId;
    }
    return ctx;
  }),
  q.str<EmitCtx>((ctx, { value: groupId }) => ({ ...ctx, groupId })),
);

const artifactIdMatch = q.alt<EmitCtx>(
  q.sym<EmitCtx>((ctx, { value }) => {
    const artifactId = ctx.resolvedVars[value];
    if (artifactId) {
      ctx.artifactId = artifactId;
    }
    return ctx;
  }),
  q.str<EmitCtx>((ctx, { value: artifactId }) => ({ ...ctx, artifactId })),
);

const versionMatch = q.alt<EmitCtx>(
  // Dotted symbol. Important to have this first in the `alt` as otherwise
  // the tree walker will eager parse a simple symbol and stop there.
  // Consumes `.op('.').sym()` repeatedly to support arbitrary nesting
  // depth (e.g. `Version.ZIO.json`). The lookup runs only once, on the
  // fully-built dotted key, so an intermediate path that happens to exist
  // in `resolvedVars` cannot shadow an unresolvable longer path.
  q
    .sym<EmitCtx>((ctx, { value: currentVarName }) => ({
      ...ctx,
      currentVarName,
    }))
    .many(
      q.op<EmitCtx>('.').sym((ctx, { value: varName }) => ({
        ...ctx,
        currentVarName: `${ctx.currentVarName}.${varName}`,
      })),
      1,
      32,
    )
    .handler((ctx) => {
      const dottedVariableName = ctx.currentVarName!;
      const currentValue = ctx.resolvedVars[dottedVariableName];
      const next = { ...ctx };
      if (currentValue) {
        next.currentValue = currentValue;
        next.variableName = dottedVariableName;
      }
      delete next.currentVarName;
      return next;
    }),
  // Simple symbol defined earlier
  q.sym<EmitCtx>((ctx, { value: varName }) => {
    // A bare symbol inherited via `object X extends Trait` resolves to the
    // trait's qualified member value and reports the dotted
    // `sharedVariableName` (`Version.avro`). Checked before the bare
    // `resolvedVars` lookup: an inherited alias therefore shadows a same-name
    // local `val` inside the object (opposite of Scala scoping), an accepted
    // tradeoff of the plan's alias-first resolution order.
    const aliasKey = ctx.qualifiedAliases?.[varName];
    if (aliasKey) {
      // `extendsHandler` only maps aliases onto keys already present in
      // `resolvedVars`, so the qualified member always resolves here. A member
      // holds a non-empty version literal, so the early return does not emit
      // an empty `currentValue`.
      ctx.currentValue = ctx.resolvedVars[aliasKey];
      ctx.variableName = aliasKey;
      return ctx;
    }
    // A bare symbol brought into scope by `import Version.*` resolves to the
    // qualified member value and reports the dotted `sharedVariableName`.
    for (const importPath of ctx.imports ?? []) {
      const qualifiedName = `${importPath}.${varName}`;
      const importedValue = ctx.resolvedVars[qualifiedName];
      if (importedValue) {
        ctx.currentValue = importedValue;
        ctx.variableName = qualifiedName;
        return ctx;
      }
    }
    const currentValue = ctx.resolvedVars[varName];
    if (currentValue) {
      ctx.currentValue = currentValue;
      ctx.variableName = varName;
    }
    return ctx;
  }),
  // Direct string
  q.str<EmitCtx>((ctx, { value: currentValue }) => ({ ...ctx, currentValue })),
);

const simpleDependencyMatch = groupIdMatch
  .op('%')
  .join(artifactIdMatch)
  .op('%')
  .join(versionMatch);

const versionedDependencyMatch = groupIdMatch
  .op('%%')
  .join(artifactIdMatch)
  .handler((ctx) => ({ ...ctx, useScalaVersion: true }))
  .op('%')
  .join(versionMatch);

const crossDependencyMatch = groupIdMatch
  .op('%%%')
  .join(artifactIdMatch)
  .handler((ctx) => ({ ...ctx, useScalaVersion: true }))
  .op('%')
  .join(versionMatch);

function depHandler(ctx: EmitCtx): EmitCtx {
  const {
    scalaVersion,
    groupId,
    artifactId,
    currentValue,
    useScalaVersion,
    depType,
    variableName,
  } = ctx;

  delete ctx.groupId;
  delete ctx.artifactId;
  delete ctx.currentValue;
  delete ctx.useScalaVersion;
  delete ctx.depType;
  delete ctx.variableName;

  const depName = `${groupId!}:${artifactId!}`;

  const dep: PackageDependency = {
    datasource: SbtPackageDatasource.id,
    depName,
    packageName:
      scalaVersion && useScalaVersion ? `${depName}_${scalaVersion}` : depName,
    currentValue,
  };

  if (depType) {
    dep.depType = depType;
  }

  if (depType === 'plugin') {
    dep.datasource = SbtPluginDatasource.id;
  }

  if (variableName) {
    dep.sharedVariableName = variableName;
    dep.variableName = variableName;
  }

  ctx.deps.push(dep);

  return ctx;
}

function depTypeHandler(
  ctx: EmitCtx,
  { value: depType }: { value: string },
): EmitCtx {
  return { ...ctx, depType };
}

const sbtPackageMatch = q
  .opt<EmitCtx>(q.opt(q.sym<EmitCtx>('lazy')).sym('val').sym().op('='))
  .alt(crossDependencyMatch, simpleDependencyMatch, versionedDependencyMatch)
  .opt(
    q.alt<EmitCtx>(
      q.sym<EmitCtx>('classifier').str(depTypeHandler),
      q.op<EmitCtx>('%').sym(depTypeHandler),
      q.op<EmitCtx>('%').str(depTypeHandler),
    ),
  )
  .handler(depHandler);

const sbtPluginMatch = q
  .sym<EmitCtx>(regEx(/^(?:addSbtPlugin|addCompilerPlugin)$/))
  .tree({
    type: 'wrapped-tree',
    maxDepth: 1,
    search: q
      .begin<EmitCtx>()
      .alt(simpleDependencyMatch, versionedDependencyMatch)
      .end(),
  })
  .handler((ctx) => ({ ...ctx, depType: 'plugin' }))
  .handler(depHandler);

const resolverMatch = q
  .str<EmitCtx>()
  .sym('at')
  .str((ctx, { value }) => {
    if (parseUrl(value)) {
      ctx.registryUrls.push(value);
    }
    return ctx;
  });

const addResolverMatch = q.sym<EmitCtx>('resolvers').alt(
  q.op<EmitCtx>('+=').join(resolverMatch),
  q.op<EmitCtx>('++=').sym('Seq').tree({
    type: 'wrapped-tree',
    maxDepth: 1,
    search: resolverMatch,
  }),
);

function registryUrlHandler(ctx: EmitCtx): EmitCtx {
  for (const dep of ctx.deps) {
    dep.registryUrls = [...ctx.registryUrls];
  }
  return ctx;
}

// Members declared inside deeper nested objects (e.g. the `ZIO` in
// `Version.ZIO.json`) are consumed here so the walker treats them as a unit
// (matching the historic behavior where doubly-nested deps are not emitted).
const nestedObjectDefinitionMatch = objectScopeMatch(variableDefinitionMatch);

// A top-level `object`/`trait` body may contain full dependency/version
// declarations (see `dependency-file.scala`) as well as nested objects, so it
// reuses the same matcher set as the root search.
const objectDefinitionMatch = objectScopeMatch(
  q.alt<EmitCtx>(
    scalaVersionMatch,
    packageFileVersionMatch,
    sbtPackageMatch,
    sbtPluginMatch,
    addResolverMatch,
    variableDefinitionMatch,
    objectAssignmentMatch,
    nestedObjectDefinitionMatch,
  ),
);

const emitQuery = q.tree<EmitCtx>({
  type: 'root-tree',
  maxDepth: 32,
  search: q.alt<EmitCtx>(
    scalaVersionMatch,
    packageFileVersionMatch,
    sbtPackageMatch,
    sbtPluginMatch,
    addResolverMatch,
    variableDefinitionMatch,
    objectAssignmentMatch,
    aliasDefinitionMatch,
    objectDefinitionMatch,
    importMatch,
  ),
  postHandler: registryUrlHandler,
});

export function extractProxyUrls(
  content: string,
  packageFile: string,
): string[] {
  const extractedProxyUrls: string[] = [];
  logger.debug(`Parsing proxy repository file ${packageFile}`);
  for (const line of content.split(newlineRegex)) {
    const extraction = sbtProxyUrlRegex.exec(line);
    if (extraction?.groups?.proxy) {
      extractedProxyUrls.push(extraction.groups.proxy);
    } else if (line.trim() === 'maven-central') {
      extractedProxyUrls.push(MAVEN_REPO);
    }
  }
  return extractedProxyUrls;
}

export function extractPackageFile(
  content: string,
  packageFile: string,
): PackageFileContent | null {
  return extractPackageFileInternal(content, packageFile);
}

// A parsed file: the immutable cursor plus the raw definitions collected from
// it in pass 1. The cursor is reused for the pass-2 emit query, so each file is
// parsed exactly once even though it is queried twice.
interface CollectedFile {
  cursor: parser.Cursor;
  vals: Vars;
  aliases: Vars;
}

function isBuildProperties(packageFile: string): boolean {
  return (
    packageFile === 'project/build.properties' ||
    packageFile.endsWith('/project/build.properties')
  );
}

function extractSbtVersion(content: string): PackageDependency | null {
  const regexResult = sbtVersionRegex.exec(content);
  const sbtVersion = regexResult?.groups?.version;
  const matchString = regexResult?.[0];
  if (!sbtVersion) {
    return null;
  }
  return {
    datasource: GithubReleasesDatasource.id,
    depName: 'sbt/sbt',
    packageName: 'sbt/sbt',
    versioning: semverVersioning.id,
    currentValue: sbtVersion,
    replaceString: matchString,
    extractVersion: '^v(?<version>\\S+)',
    registryUrls: [],
  };
}

// Parse once and run the pass-1 collection query. Returns the cursor (reused
// by the pass-2 emit query) plus the raw `vals`/`aliases`. Callers wrap this in
// a try/catch, since `scala.parse` may throw on pathological input.
function collectPackageFile(content: string): CollectedFile {
  const cursor = scala.parse(content);
  const collected = scala.query<CollectCtx, parser.Node>(cursor, collectQuery, {
    vals: {},
    aliases: {},
  });
  // `query` returns null when the file has no collectable definitions; the
  // cursor is still valid for the emit pass.
  return {
    cursor,
    vals: collected?.vals ?? {},
    aliases: collected?.aliases ?? {},
  };
}

// Run the pass-2 emission query over an already-parsed cursor against the
// pre-resolved value table.
function emitPackageFile(
  cursor: parser.Cursor,
  resolvedVars: Vars,
  ctxScalaVersion?: string,
): PackageFileContent | null {
  const emitResult = scala.query<EmitCtx, parser.Node>(cursor, emitQuery, {
    resolvedVars,
    deps: [],
    registryUrls: [],
    scalaVersion: ctxScalaVersion,
  });

  if (!emitResult?.deps.length) {
    return null;
  }

  const { deps, scalaVersion, packageFileVersion } = emitResult;
  return { deps, packageFileVersion, managerData: { scalaVersion } };
}

function extractPackageFileInternal(
  content: string,
  packageFile: string,
): PackageFileContent | null {
  if (isBuildProperties(packageFile)) {
    const sbtDependency = extractSbtVersion(content);
    return sbtDependency ? { deps: [sbtDependency] } : null;
  }

  try {
    const collected = collectPackageFile(content);
    const resolvedVars = resolve({
      vals: collected.vals,
      aliases: collected.aliases,
    });
    return emitPackageFile(collected.cursor, resolvedVars);
  } catch (err) /* v8 ignore next 4 -- defensive: parser exceptions are rare */ {
    logger.debug({ err, packageFile }, 'Sbt parsing error');
    return null;
  }
}

export async function extractAllPackageFiles(
  _config: ExtractConfig,
  packageFiles: string[],
): Promise<PackageFile[]> {
  const packages: PackageFile[] = [];
  const proxyUrls: string[] = [];
  let ctxScalaVersion: string | undefined;

  const sortedPackageFiles = sortPackageFiles(packageFiles);

  // A file staged for the emit pass, in global `sortPackageFiles` order.
  // `build.properties` files carry a pre-built dependency; `.sbt`/`.scala`
  // files carry their parsed cursor and directory.
  type PendingFile =
    | { kind: 'sbtVersion'; packageFile: string; dep: PackageDependency }
    | {
        kind: 'scala';
        packageFile: string;
        dir: string;
        collected: CollectedFile;
      };

  const pending: PendingFile[] = [];
  // Per-directory value tables, merged from every sibling file so resolution
  // is order-independent within a directory. Scoped by directory so a `val` in
  // one module's build does not leak into a sibling module's build.
  const dirTables: Record<string, CollectedTable> = {};

  // Pass 1 (all files): read, parse, and collect per-directory value tables.
  for (const packageFile of sortedPackageFiles) {
    const content = await readLocalFile(packageFile, 'utf8');
    if (!content) {
      logger.debug({ packageFile }, 'packageFile has no content');
      continue;
    }
    if (packageFile === 'repositories') {
      proxyUrls.push(...extractProxyUrls(content, packageFile));
      continue;
    }
    if (isBuildProperties(packageFile)) {
      const dep = extractSbtVersion(content);
      if (dep) {
        pending.push({ kind: 'sbtVersion', packageFile, dep });
      }
      continue;
    }
    const dir = upath.parse(packageFile).dir;
    let collected: CollectedFile;
    try {
      collected = collectPackageFile(content);
    } catch (err) /* v8 ignore next 4 -- defensive: parser exceptions are rare */ {
      logger.debug({ err, packageFile }, 'Sbt parsing error');
      continue;
    }
    // Merge into the directory table; a later file in `sortPackageFiles` order
    // overwrites an earlier sibling's key (last-write-wins).
    dirTables[dir] = {
      vals: { ...dirTables[dir]?.vals, ...collected.vals },
      aliases: { ...dirTables[dir]?.aliases, ...collected.aliases },
    };
    pending.push({ kind: 'scala', packageFile, dir, collected });
  }

  // Resolve each directory's merged table once.
  const resolvedByDir: Record<string, Vars> = {};
  for (const dir of Object.keys(dirTables)) {
    resolvedByDir[dir] = resolve(dirTables[dir]);
  }

  // Pass 2 (global order): emit each file against its directory's resolved
  // table. `scalaVersion` is threaded forward here, exactly as before.
  for (const file of pending) {
    if (file.kind === 'sbtVersion') {
      packages.push({
        deps: [file.dep],
        packageFile: file.packageFile,
      });
      continue;
    }
    let packageFileContent: PackageFileContent | null;
    try {
      packageFileContent = emitPackageFile(
        file.collected.cursor,
        resolvedByDir[file.dir],
        ctxScalaVersion,
      );
    } catch (err) /* v8 ignore next 4 -- defensive: parser exceptions are rare */ {
      logger.debug({ err, packageFile: file.packageFile }, 'Sbt parsing error');
      continue;
    }
    if (packageFileContent) {
      packages.push({
        deps: packageFileContent.deps,
        packageFile: file.packageFile,
      });
      if (packageFileContent.managerData?.scalaVersion) {
        ctxScalaVersion = packageFileContent.managerData.scalaVersion;
      }
    }
  }
  for (const pkg of packages) {
    for (const dep of pkg.deps) {
      if (dep.datasource !== GithubReleasesDatasource.id) {
        if (proxyUrls.length > 0) {
          dep.registryUrls!.unshift(...proxyUrls);
        } else if (dep.depType === 'plugin') {
          dep.registryUrls!.unshift(SBT_PLUGINS_REPO, MAVEN_REPO);
        } else {
          dep.registryUrls!.unshift(MAVEN_REPO);
        }
      }
    }
  }
  return packages;
}
