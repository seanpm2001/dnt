// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.

import { outputDiagnostics } from "./lib/compiler.ts";
import { colors, createProjectSync, path, ts } from "./lib/mod.deps.ts";
import { getTestFilePaths } from "./lib/test_files.ts";
import { PackageJsonObject } from "./lib/types.ts";
import {
  Dependency,
  OutputFile,
  transform,
  TransformOutput,
} from "./transform.ts";

export * from "./transform.ts";

export interface BuildOptions {
  entryPoints: (string | URL)[];
  outDir: string;
  typeCheck?: boolean;
  /** Whether to collect and run test files. */
  test?: boolean;
  /** Whether to keep the test files after tests run. */
  keepTestFiles?: boolean;
  /** The root directory to find test files in. Defaults to the cwd. */
  rootTestDir?: string;
  shimPackage?: {
    name: string;
    version: string;
  };
  /** Specifiers to map from and to. */
  mappings?: {
    [specifier: string]: {
      /** Name of the specifier to map to. */
      name: string;
      /** Version to use in the package.json file.
       *
       * Not specifying a version will exclude it from the package.json file.
       */
      version?: string;
    };
  };
  package: PackageJsonObject;
  writeFile?: (filePath: string, text: string) => void;
}

/** Emits the specified Deno module to an npm package using the TypeScript compiler. */
export async function build(options: BuildOptions): Promise<void> {
  const warnedMessages = new Set<string>();
  await Deno.permissions.request({ name: "write", path: options.outDir });

  const shimPackage = options.shimPackage ?? {
    name: "deno.ns",
    version: "0.5.0",
  };
  const specifierMappings = options.mappings && Object.fromEntries(
    Object.entries(options.mappings).map(([key, value]) => {
      const lowerCaseKey = key.toLowerCase();
      if (
        !lowerCaseKey.startsWith("http://") &&
        !lowerCaseKey.startsWith("https://")
      ) {
        key = path.toFileUrl(lowerCaseKey).toString();
      }
      return [key, value];
    }),
  );

  log("Transforming...");
  const transformOutput = await transformEntryPoints(options.entryPoints);
  for (const warning of transformOutput.warnings) {
    warnOnce(warning);
  }

  let testOutput: TestOutput | undefined;
  if (options.test) {
    testOutput = await getTestOutput();
  }

  const createdDirectories = new Set<string>();
  const writeFile = options.writeFile ??
    ((filePath: string, fileText: string) => {
      const dir = path.dirname(filePath);
      if (!createdDirectories.has(dir)) {
        Deno.mkdirSync(dir, { recursive: true });
        createdDirectories.add(dir);
      }
      Deno.writeTextFileSync(filePath, fileText);
    });

  createPackageJson();
  createNpmIgnore();

  // npm install in order to prepare for checking TS diagnostics
  log("Running npm install...");
  await runNpmCommand(["install"]);

  log("Building TypeScript project...");
  const esmOutDir = path.join(options.outDir, "esm");
  const cjsOutDir = path.join(options.outDir, "cjs");
  const typesOutDir = path.join(options.outDir, "types");
  const project = createProjectSync({
    compilerOptions: {
      outDir: typesOutDir,
      allowJs: true,
      stripInternal: true,
      declaration: true,
      esModuleInterop: false,
      isolatedModules: true,
      useDefineForClassFields: true,
      experimentalDecorators: true,
      jsx: ts.JsxEmit.React,
      jsxFactory: "React.createElement",
      jsxFragmentFactory: "React.Fragment",
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      module: ts.ModuleKind.ES2015,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      target: ts.ScriptTarget.ES2015,
      allowSyntheticDefaultImports: true,
    },
  });

  for (
    const outputFile of [...transformOutput.files, ...(testOutput?.files ?? [])]
  ) {
    project.createSourceFile(
      path.join(options.outDir, "src", outputFile.filePath),
      outputFile.fileText,
    );
  }

  let program = project.createProgram();

  if (options.typeCheck) {
    log("Type checking...");
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      outputDiagnostics(diagnostics);
      Deno.exit(1);
    }
  }

  // emit only the .d.ts files
  log("Emitting declaration files...");
  emit({ onlyDtsFiles: true });

  // emit the esm files
  log("Emitting esm module...");
  project.compilerOptions.set({
    declaration: false,
    outDir: esmOutDir,
  });
  program = project.createProgram();
  emit();
  writeFile(
    path.join(esmOutDir, "package.json"),
    `{\n  "type": "module"\n}\n`,
  );

  // emit the cjs files
  log("Emitting cjs module...");
  project.compilerOptions.set({
    declaration: false,
    esModuleInterop: true,
    outDir: cjsOutDir,
    module: ts.ModuleKind.CommonJS,
  });
  program = project.createProgram();
  emit();
  writeFile(
    path.join(cjsOutDir, "package.json"),
    `{\n  "type": "commonjs"\n}\n`,
  );

  if (testOutput) {
    log("Running tests...");
    await createTestLauncherScript();
    await runNpmCommand(["run", "test"]);
    if (!options.keepTestFiles) {
      await deleteTestFiles();
    }
  }

  log("Complete!");

  function emit(opts?: { onlyDtsFiles?: boolean }) {
    const emitResult = program.emit(
      undefined,
      (filePath, data, writeByteOrderMark) => {
        if (writeByteOrderMark) {
          data = "\uFEFF" + data;
        }
        writeFile(filePath, data);
      },
      undefined,
      opts?.onlyDtsFiles,
    );

    if (emitResult.diagnostics.length > 0) {
      outputDiagnostics(emitResult.diagnostics);
      Deno.exit(1);
    }
  }

  function createPackageJson() {
    const entryPointPath = transformOutput
      .entryPoints[0]
      .replace(/\.ts$/i, ".js");
    const entryPointDtsFilePath = transformOutput
      .entryPoints[0]
      .replace(/\.ts$/i, ".d.ts");
    const dependencies = {
      // add dependencies from transform
      ...Object.fromEntries(
        transformOutput.dependencies.map((d) => [d.name, d.version]),
      ),
      // add specifier mappings to dependencies
      ...(specifierMappings && Object.fromEntries(
        Object.values(specifierMappings)
          .filter((v) => v.version)
          .map((value) => [value.name, value.version]),
      )) ?? {},
      // add shim
      ...(transformOutput.shimUsed
        ? {
          [shimPackage.name]: shimPackage.version,
        }
        : {}),
      // override with specified dependencies
      ...(options.package.dependencies ?? {}),
    };
    const devDependencies = testOutput
      ? ({
        // add dependencies from transform
        ...Object.fromEntries(
          testOutput.dependencies.map((d) => [d.name, d.version]) ?? [],
        ),
        // add shim if not in dependencies
        ...(testOutput.shimUsed &&
            !Object.keys(dependencies).includes(shimPackage.name)
          ? {
            [shimPackage.name]: shimPackage.version,
          }
          : {}),
        // override with specified dependencies
        ...(options.package.devDependencies ?? {}),
      })
      : options.package.devDependencies;
    const scripts = testOutput
      ? ({
        test: "node test_runner.js",
        // override with specified scripts
        ...(options.package.scripts ?? {}),
      })
      : options.package.scripts;

    const packageJsonObj = {
      ...options.package,
      module: options.package.module ?? `./esm/${entryPointPath}`,
      main: options.package.main ?? `./cjs/${entryPointPath}`,
      types: options.package.types ?? `./types/${entryPointDtsFilePath}`,
      exports: {
        ...(options.package.exports ?? {}),
        ".": {
          import: `./esm/${entryPointPath}`,
          require: `./cjs/${entryPointPath}`,
          types: options.package.types ?? `./types/${entryPointDtsFilePath}`,
          ...(options.package.exports?.["."] ?? {}),
        },
      },
      scripts,
      dependencies,
      devDependencies,
    };
    writeFile(
      path.join(options.outDir, "package.json"),
      JSON.stringify(packageJsonObj, undefined, 2),
    );
  }

  function createNpmIgnore() {
    if (!testOutput) {
      return;
    }

    const fileText = Array.from(getTestFileNames()).join("\n");
    writeFile(
      path.join(options.outDir, ".npmignore"),
      fileText,
    );
  }

  async function deleteTestFiles() {
    for (const file of getTestFileNames()) {
      await Deno.remove(path.join(options.outDir, file));
    }
  }

  function* getTestFileNames() {
    if (!testOutput) {
      return;
    }

    for (const file of testOutput.files) {
      const filePath = file.filePath.replace(/\.ts$/i, ".js");
      yield `./esm/${filePath}`;
      yield `./cjs/${filePath}`;
    }
    yield "./test_runner.js";
  }

  interface TestOutput {
    entryPoints: string[];
    shimUsed: boolean;
    dependencies: Dependency[];
    files: OutputFile[];
  }

  async function getTestOutput(): Promise<TestOutput | undefined> {
    const testFilePaths = await getTestFilePaths({
      rootDir: options.rootTestDir ?? Deno.cwd(),
      excludeDirs: [options.outDir],
    });
    if (testFilePaths.length === 0) {
      return undefined;
    }

    log("Transforming test files...");
    const testTransformOutput = await transformEntryPoints([
      ...testFilePaths,
      ...options.entryPoints,
    ]);
    for (const warning of testTransformOutput.warnings) {
      warnOnce(warning);
    }
    const outputFileNames = new Set(
      transformOutput.files.map((f) => f.filePath),
    );
    const testFiles = testTransformOutput.files.filter((f) =>
      !outputFileNames.has(f.filePath)
    );

    if (testFiles.length === 0) {
      return undefined;
    }

    const outputDependencyNames = new Set(
      transformOutput.dependencies.map((d) => d.name),
    );
    const outputEntryPoints = new Set(transformOutput.entryPoints);

    return {
      entryPoints: testTransformOutput.entryPoints.filter((e) =>
        !outputEntryPoints.has(e)
      ),
      shimUsed: testTransformOutput.shimUsed,
      dependencies: testTransformOutput.dependencies.filter((d) =>
        !outputDependencyNames.has(d.name)
      ),
      files: testFiles,
    };
  }

  function transformEntryPoints(
    entryPoints: (string | URL)[],
  ): Promise<TransformOutput> {
    return transform({
      entryPoints,
      shimPackageName: shimPackage.name,
      specifierMappings: specifierMappings && Object.fromEntries(
        Object.entries(specifierMappings).map(([key, value]) => {
          return [key, value.name];
        }),
      ),
    });
  }

  function log(message: string) {
    console.log(`[dnt] ${message}`);
  }

  function warnOnce(message: string) {
    if (!warnedMessages.has(message)) {
      warnedMessages.add(message);
      warn(message);
    }
  }

  function warn(message: string) {
    console.warn(colors.yellow(`[dnt] ${message}`));
  }

  async function createTestLauncherScript() {
    if (!testOutput) {
      return;
    }

    let fileText = "";
    if (testOutput.shimUsed) {
      fileText += `const denoShim = require("${shimPackage.name}");\n` +
        `const { testDefinitions } = require("${shimPackage.name}/test-internals");\n\n`;
    }

    fileText += "const filePaths = [\n";
    for (const entryPoint of testOutput.entryPoints) {
      fileText += `  "${entryPoint.replace(/\.ts$/, ".js")}",\n`;
    }
    fileText += "];\n\n";

    fileText += `async function main() {
  for (const filePath of filePaths) {
    const cjsPath = "./cjs/" + filePath;
    console.log("\\nRunning tests in " + cjsPath + "...\\n");
    require(cjsPath);
    await runTestDefinitions();
    const esmPath = "./esm/" + filePath;
    console.log("\\nRunning tests in " + esmPath + "...\\n");
    await import(esmPath);
    await runTestDefinitions();
  }
}\n\n`;
    if (testOutput.shimUsed) {
      fileText += `${getRunTestDefinitionsCode()}\n\n`;
    }
    fileText += "main();\n";

    writeFile(
      path.join(options.outDir, "test_runner.js"),
      fileText,
    );
  }

  async function runNpmCommand(args: string[]) {
    const cmd = getCmd();
    await Deno.permissions.request({ name: "run", command: cmd[0] });
    const process = Deno.run({
      cmd,
      cwd: options.outDir,
      stderr: "inherit",
      stdout: "inherit",
      stdin: "inherit",
    });

    try {
      const status = await process.status();
      if (!status.success) {
        throw new Error(
          `npm ${args.join(" ")} failed with exit code ${status.code}`,
        );
      }
    } finally {
      process.close();
    }

    function getCmd() {
      const cmd = ["npm", ...args];
      if (Deno.build.os === "windows") {
        return ["cmd", "/c", ...cmd];
      } else {
        return cmd;
      }
    }
  }
}

function getRunTestDefinitionsCode() {
  // todo: extract out for unit testing
  return `
async function runTestDefinitions() {
  const currentDefinitions = testDefinitions.splice(0, testDefinitions.length);
  const testFailures = [];
  for (const definition of currentDefinitions) {
    process.stdout.write(definition.name + " ...");
    if (definition.ignored) {
     process.stdout.write(" ignored\\n");
     continue;
    }
    const context = getTestContext();
    let pass = false;
    try {
      await definition.fn(context);
      if (context.hasFailingChild) {
        testFailures.push({ name: definition.name, err: new Error("Had failing test step.") });
      } else {
        pass = true;
      }
    } catch (err) {
      testFailures.push({ name: definition.name, err });
    }
    const testStepOutput = context.getOutput();
    if (testStepOutput.length > 0) {
      process.stdout.write(testStepOutput);
    } else {
      process.stdout.write(" ");
    }
    process.stdout.write(pass ? "ok\\n" : "fail\\n");
  }

  if (testFailures.length > 0) {
    console.log("\\nFAILURES\\n");
    for (const failure of testFailures) {
      console.log(failure.name);
      console.log(indentText(failure.err, 1));
      console.log("");
    }
    process.exit(1);
  }
}

function getTestContext() {
  return {
    name: undefined,
    status: "ok",
    children: [],
    get hasFailingChild() {
      return this.children.some(c => c.status === "fail" || c.status === "pending");
    },
    getOutput() {
      let output = "";
      if (this.name) {
        output += this.name + " ...";
      }
      if (this.children.length > 0) {
        output += "\\n" + this.children.map(c => indentText(c.getOutput(), 1)).join("\\n") + "\\n";
      } else if (!this.err) {
        output += " ";
      }
      if (this.name && this.err) {
        output += "\\n";
      }
      if (this.err) {
        output += indentText(this.err.toString(), 1);
        if (this.name) {
          output += "\\n";
        }
      }
      if (this.name) {
        output += this.status;
      }
      return output;
    },
    async step(nameOrTestDefinition, fn) {
      const definition = getDefinition();

      const context = getTestContext();
      context.status = "pending";
      context.name = definition.name;
      context.status = "pending";
      this.children.push(context);

      if (definition.ignored) {
        context.status = "ignored";
        return false;
      }

      try {
        await definition.fn(context);
        context.status = "ok";
        if (context.hasFailingChild) {
          context.status = "fail";
          return false;
        }
        return true;
      } catch (err) {
        context.status = "fail";
        context.err = err;
        return false;
      }

      function getDefinition() {
        if (typeof nameOrTestDefinition === "string") {
          if (!(fn instanceof Function)) {
            throw new TypeError("Expected function for second argument.");
          }
          return {
            name: nameOrTestDefinition,
            fn,
          };
        } else if (typeof nameOrTestDefinition === "object") {
          return nameOrTestDefinition;
        } else {
          throw new TypeError(
            "Expected a test definition or name and function.",
          );
        }
      }
    }
  };
}

function indentText(text, indentLevel) {
  if (text === undefined) {
    text = "[undefined]";
  } else if (text === null) {
    text = "[null]";
  } else {
    text = text.toString();
  }
  return text.split(/\\r?\\n/).map(line => "  ".repeat(indentLevel) + line).join("\\n");
}
`.trim();
}