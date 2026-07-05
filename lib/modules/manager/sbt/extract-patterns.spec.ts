import { codeBlock } from 'common-tags';
import { fs } from '~test/util.ts';
import {
  extractPackageFile as extract,
  extractAllPackageFiles,
} from './extract.ts';

vi.mock('../../../util/fs/index.ts');

const extractPackageFile = (content: string) => extract(content, 'build.sbt');

/**
 * Pattern coverage suite for SBT version-resolution styles.
 *
 * Each test documents a real-world way of declaring/referencing dependency
 * versions. Tests are grouped by whether the value is statically resolvable.
 * The goal is to make explicit which patterns are supported by `extract.ts`.
 */
describe('modules/manager/sbt/extract-patterns', () => {
  describe('inline version literals', () => {
    it('resolves an inline version string', () => {
      const content = codeBlock`
        scalaVersion := "2.13.8"
        libraryDependencies += "org.example" % "foo" % "1.2.3"
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          { packageName: 'org.example:foo', currentValue: '1.2.3' },
        ],
      });
    });
  });

  describe('version in a variable in the same file', () => {
    it('resolves a `val` reference', () => {
      const content = codeBlock`
        scalaVersion := "2.13.8"
        val avro = "1.2.3"
        libraryDependencies += "org.apache.avro" % "avro" % avro
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'avro',
          },
        ],
      });
    });

    it('resolves a `lazy val` reference', () => {
      const content = codeBlock`
        scalaVersion := "2.13.8"
        lazy val avro = "1.2.3"
        libraryDependencies += "org.apache.avro" % "avro" % avro
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'avro',
          },
        ],
      });
    });

    it('resolves a typed `val` reference', () => {
      const content = codeBlock`
        scalaVersion := "2.13.8"
        val avro: String = "1.2.3"
        libraryDependencies += "org.apache.avro" % "avro" % avro
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'avro',
          },
        ],
      });
    });
  });

  describe('versions grouped in an object (same file)', () => {
    it('resolves `Version.avro` from a named object', () => {
      const content = codeBlock`
        scalaVersion := "2.13.8"
        object Version {
          val avro = "1.2.3"
        }
        libraryDependencies += "org.apache.avro" % "avro" % Version.avro
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'Version.avro',
          },
        ],
      });
    });

    it('resolves `lazy val` inside a named object', () => {
      const content = codeBlock`
        scalaVersion := "2.13.8"
        object Version {
          lazy val avro = "1.2.3"
        }
        libraryDependencies += "org.apache.avro" % "avro" % Version.avro
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'Version.avro',
          },
        ],
      });
    });
  });

  describe('imported object members referenced directly', () => {
    // A wildcard `import Version.*` / `import Version._` brings the object's
    // members into scope, so a bare `avro` reference resolves to the qualified
    // member and reports `sharedVariableName: 'Version.avro'`.
    it('resolves a bare val after `import Version.*`', () => {
      const content = codeBlock`
        import Version.*
        scalaVersion := "2.13.8"
        object Version {
          val avro = "1.2.3"
        }
        libraryDependencies += "org.apache.avro" % "avro" % avro
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'Version.avro',
          },
        ],
      });
    });
  });

  describe('nested objects', () => {
    it('resolves `Version.ZIO.json`', () => {
      const content = codeBlock`
        scalaVersion := "2.13.8"
        object Version {
          object ZIO {
            val base = "2.0.0"
            val http = "3.0.0"
            val json = "0.6.0"
          }
        }
        libraryDependencies += "dev.zio" %% "zio-json" % Version.ZIO.json
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          {
            packageName: 'dev.zio:zio-json_2.13',
            currentValue: '0.6.0',
            sharedVariableName: 'Version.ZIO.json',
          },
        ],
      });
    });
  });

  describe('aliasing', () => {
    it('resolves a single-value alias `val avroVersion = Version.avro`', () => {
      const content = codeBlock`
        scalaVersion := "2.13.8"
        object Version {
          val avro = "1.2.3"
        }
        val avroVersion = Version.avro
        val avroVersionAlias = avroVersion
        libraryDependencies += "org.apache.avro" % "avro" % avroVersion
        libraryDependencies += "org.apache.avro" % "avro-tools" % avroVersionAlias
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'avroVersion',
          },
          {
            packageName: 'org.apache.avro:avro-tools',
            currentValue: '1.2.3',
            sharedVariableName: 'avroVersionAlias',
          },
        ],
      });
    });

    it('resolves a forward-referenced alias', () => {
      const content = codeBlock`
        val avroVersionAlias = avroVersion
        val avroVersion = "1.2.3"
        libraryDependencies += "org.apache.avro" % "avro" % avroVersionAlias
      `;

      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'avroVersionAlias',
          },
        ],
      });
    });
    it('resolves a chained forward-referenced alias', () => {
      const content = codeBlock`
        val a = b
        val b = c
        val c = "1.2.3"
        libraryDependencies += "org.apache.avro" % "avro" % a
      `;

      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'a',
          },
        ],
      });
    });

    it('leaves a cyclic alias unresolved without hanging', () => {
      const content = codeBlock`
        val a = b
        val b = a
        libraryDependencies += "org.apache.avro" % "avro" % a
      `;

      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          {
            packageName: 'org.apache.avro:avro',
            currentValue: undefined,
          },
        ],
      });
    });
  });

  describe('trait-based version holder', () => {
    // `object Dependencies extends Version` mixes in the trait's members, so a
    // bare `avro` reference inside the object resolves to the inherited
    // qualified member and reports `sharedVariableName: 'Version.avro'`.
    it('resolves vals from a trait mixed into an object', () => {
      const content = codeBlock`
        scalaVersion := "2.13.8"
        trait Version {
          val avro = "1.2.3"
        }
        object Dependencies extends Version {
          val avroDep = "org.apache.avro" % "avro" % avro
        }
        libraryDependencies += Dependencies.avroDep
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          { packageName: 'org.scala-lang:scala-library' },
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'Version.avro',
          },
        ],
      });
    });

    it('does not leak inherited vals into sibling objects', () => {
      const content = codeBlock`
        trait Version {
          val avro = "1.2.3"
        }
        object Dependencies extends Version {
          val avroDep = "org.apache.avro" % "avro" % avro
        }
        object Other {
          val otherDep = "com.other" % "other" % avro
        }
      `;
      expect(extractPackageFile(content)).toMatchObject({
        deps: [
          {
            packageName: 'org.apache.avro:avro',
            currentValue: '1.2.3',
            sharedVariableName: 'Version.avro',
          },
          {
            packageName: 'com.other:other',
            currentValue: '1.2.3',
            sharedVariableName: 'avro',
          },
        ],
      });
    });
  });

  describe('cross-file resolution', () => {
    // Definitions live in project/Version.scala; usage lives in
    // project/Dependencies.scala. sbt makes sibling project/*.scala files
    // visible to each other, so version vars must be resolvable across files.
    // Note: shallower project dirs may reference deeper ones, not vice versa.

    it('resolves `object Version` referenced via `Version.avro` from another file', async () => {
      const version = codeBlock`
        object Version {
          val avro = "1.2.3"
        }
      `;
      const dependencies = codeBlock`
        object Dependencies {
          val avro = "org.apache.avro" % "avro" % Version.avro
        }
      `;
      fs.readLocalFile
        .mockResolvedValueOnce(version)
        .mockResolvedValueOnce(dependencies);
      const packages = await extractAllPackageFiles({}, [
        'project/Version.scala',
        'project/Dependencies.scala',
      ]);
      expect(packages).toMatchObject([
        {
          packageFile: 'project/Dependencies.scala',
          deps: [
            {
              packageName: 'org.apache.avro:avro',
              currentValue: '1.2.3',
              sharedVariableName: 'Version.avro',
            },
          ],
        },
      ]);
    });

    it('resolves `object Version` via `import Version.*` from another file', async () => {
      const version = codeBlock`
        object Version {
          val avro = "1.2.3"
        }
      `;
      const dependencies = codeBlock`
        import Version.*
        object Dependencies {
          val avro = "org.apache.avro" % "avro" % avro
        }
      `;
      fs.readLocalFile
        .mockResolvedValueOnce(version)
        .mockResolvedValueOnce(dependencies);
      const packages = await extractAllPackageFiles({}, [
        'project/Version.scala',
        'project/Dependencies.scala',
      ]);
      expect(packages).toMatchObject([
        {
          packageFile: 'project/Dependencies.scala',
          deps: [
            {
              packageName: 'org.apache.avro:avro',
              currentValue: '1.2.3',
            },
          ],
        },
      ]);
    });

    it('resolves `trait Version` extended by `object Dependencies` referencing parent vals directly', async () => {
      const version = codeBlock`
        trait Version {
          val avro = "1.2.3"
        }
      `;
      const dependencies = codeBlock`
        object Dependencies extends Version {
          val avro = "org.apache.avro" % "avro" % avro
        }
      `;
      fs.readLocalFile
        .mockResolvedValueOnce(version)
        .mockResolvedValueOnce(dependencies);
      const packages = await extractAllPackageFiles({}, [
        'project/Version.scala',
        'project/Dependencies.scala',
      ]);
      expect(packages).toMatchObject([
        {
          packageFile: 'project/Dependencies.scala',
          deps: [
            {
              packageName: 'org.apache.avro:avro',
              currentValue: '1.2.3',
            },
          ],
        },
      ]);
    });

    it('resolves when the usage file is listed before the definition file', async () => {
      const version = codeBlock`
        object Version {
          val avro = "1.2.3"
        }
      `;
      const dependencies = codeBlock`
        object Dependencies {
          val avro = "org.apache.avro" % "avro" % Version.avro
        }
      `;
      // Usage file returned first: resolution must be order-independent.
      fs.readLocalFile
        .mockResolvedValueOnce(dependencies)
        .mockResolvedValueOnce(version);
      const packages = await extractAllPackageFiles({}, [
        'project/Dependencies.scala',
        'project/Version.scala',
      ]);
      expect(packages).toMatchObject([
        {
          packageFile: 'project/Dependencies.scala',
          deps: [
            {
              packageName: 'org.apache.avro:avro',
              currentValue: '1.2.3',
              sharedVariableName: 'Version.avro',
            },
          ],
        },
      ]);
    });

    it('lets the later sibling file win a duplicate key', async () => {
      const versionA = codeBlock`
        object Version {
          val avro = "1.0.0"
        }
      `;
      const versionB = codeBlock`
        object Version {
          val avro = "2.0.0"
        }
      `;
      const dependencies = codeBlock`
        object Dependencies {
          val avro = "org.apache.avro" % "avro" % Version.avro
        }
      `;
      fs.readLocalFile
        .mockResolvedValueOnce(versionA)
        .mockResolvedValueOnce(versionB)
        .mockResolvedValueOnce(dependencies);
      const packages = await extractAllPackageFiles({}, [
        'project/VersionA.scala',
        'project/VersionB.scala',
        'project/Dependencies.scala',
      ]);
      expect(packages).toMatchObject([
        {
          packageFile: 'project/Dependencies.scala',
          deps: [
            {
              packageName: 'org.apache.avro:avro',
              currentValue: '2.0.0',
              sharedVariableName: 'Version.avro',
            },
          ],
        },
      ]);
    });

    it('does not let an import in one sibling rename a bare reference in another', async () => {
      const version = codeBlock`
        object Version {
          val avro = "1.2.3"
        }
      `;
      // Imports `Version.*` so its own bare `avro` reports qualified.
      const withImport = codeBlock`
        import Version.*
        object Dependencies {
          val avroDep = "org.apache.avro" % "avro" % avro
        }
      `;
      // No import: a bare `avro` here still resolves (object members register
      // bare keys) but must report the bare name, not the sibling's qualified
      // `Version.avro` — the import must not leak across files.
      const withoutImport = codeBlock`
        object Other {
          val otherDep = "com.other" % "other" % avro
        }
      `;
      fs.readLocalFile
        .mockResolvedValueOnce(version)
        .mockResolvedValueOnce(withImport)
        .mockResolvedValueOnce(withoutImport);
      const packages = await extractAllPackageFiles({}, [
        'project/Version.scala',
        'project/WithImport.scala',
        'project/WithoutImport.scala',
      ]);
      expect(packages).toMatchObject([
        {
          packageFile: 'project/WithImport.scala',
          deps: [
            {
              packageName: 'org.apache.avro:avro',
              currentValue: '1.2.3',
              sharedVariableName: 'Version.avro',
            },
          ],
        },
        {
          packageFile: 'project/WithoutImport.scala',
          deps: [
            {
              packageName: 'com.other:other',
              currentValue: '1.2.3',
              sharedVariableName: 'avro',
            },
          ],
        },
      ]);
    });

    it('does not leak `val`s between sibling module builds', async () => {
      const moduleA = codeBlock`
        val avro = "1.2.3"
        libraryDependencies += "org.apache.avro" % "avro" % avro
      `;
      const moduleB = codeBlock`
        libraryDependencies += "org.apache.avro" % "avro" % avro
      `;
      fs.readLocalFile
        .mockResolvedValueOnce(moduleA)
        .mockResolvedValueOnce(moduleB);

      const packages = await extractAllPackageFiles({}, [
        'moduleA/build.sbt',
        'moduleB/build.sbt',
      ]);

      expect(packages).toMatchObject([
        {
          packageFile: 'moduleA/build.sbt',
          deps: [
            {
              packageName: 'org.apache.avro:avro',
              currentValue: '1.2.3',
              sharedVariableName: 'avro',
            },
          ],
        },
        {
          packageFile: 'moduleB/build.sbt',
          deps: [
            { packageName: 'org.apache.avro:avro', currentValue: undefined },
          ],
        },
      ]);
    });
  });
});
