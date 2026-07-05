Extracts Maven artifact dependencies for SBT.

## Dependency versions

Renovate resolves dependency versions defined in the following ways:

- **Inline literal** — the version given directly in the dependency:

  ```scala
  libraryDependencies += "org.apache.avro" % "avro" % "1.2.3"
  ```

- **Variable** — a `val`, `lazy val`, or type-annotated `val`:

  ```scala
  val avro = "1.2.3"
  libraryDependencies += "org.apache.avro" % "avro" % avro
  ```

- **Object member** — a member referenced through its object, including
  nested objects:

  ```scala
  object Version {
    object ZIO {
      val json = "0.6.0"
    }
  }
  libraryDependencies += "dev.zio" %% "zio-json" % Version.ZIO.json
  ```

- **Anonymous object field** — a field of an anonymous object assigned to a
  `val`. The field is qualified with the `val` name it is assigned to, so
  `versions.avro` resolves the `avro` field of `versions`:

  ```scala
  val versions = new {
    val avro = "1.2.3"
  }
  libraryDependencies += "org.apache.avro" % "avro" % versions.avro
  ```

- **Imported member** — an object member brought into scope with a wildcard
  `import` (`import Version.*` or `import Version._`):

  ```scala
  import Version.*
  libraryDependencies += "org.apache.avro" % "avro" % avro
  ```

- **Inherited member** — a member inherited from an extended trait:

  ```scala
  trait Version {
    val avro = "1.2.3"
  }
  object Dependencies extends Version {
    libraryDependencies += "org.apache.avro" % "avro" % avro
  }
  ```

- **Alias** — a variable pointing at another resolvable value, including
  chained aliases:

  ```scala
  val avroVersion = Version.avro
  val avroVersionAlias = avroVersion
  libraryDependencies += "org.apache.avro" % "avro" % avroVersion
  libraryDependencies += "org.apache.avro" % "avro-tools" % avroVersionAlias
  ```

These forms are also resolved **across files in the same directory**, so
versions declared in one `project/*.scala` file (for example
`project/Version.scala`) can be referenced from another in the same directory
(for example `project/Dependencies.scala`). Values are not shared across
different directories.
