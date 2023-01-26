import * as path from "path";
import * as fse from "fs-extra";
import { builtinModules as nodeBuiltins } from "module";
import * as esbuild from "esbuild";
import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";
import postcss from "postcss";
import postcssDiscardDuplicates from "postcss-discard-duplicates";

import type { WriteChannel } from "../channel";
import type { RemixConfig } from "../config";
import type { AssetsManifest } from "./assets";
import { createAssetsManifest } from "./assets";
import { getAppDependencies } from "./dependencies";
import { loaders } from "./loaders";
import type { CompileOptions } from "./options";
import { browserRouteModulesPlugin } from "./plugins/browserRouteModulesPlugin";
import { cssFilePlugin } from "./plugins/cssFilePlugin";
import { deprecatedRemixPackagePlugin } from "./plugins/deprecatedRemixPackagePlugin";
import { emptyModulesPlugin } from "./plugins/emptyModulesPlugin";
import { mdxPlugin } from "./plugins/mdx";
import { urlImportsPlugin } from "./plugins/urlImportsPlugin";
import { cssModulesPlugin } from "./plugins/cssModulesPlugin";
import { cssSideEffectImportsPlugin } from "./plugins/cssSideEffectImportsPlugin";
import { vanillaExtractPlugin } from "./plugins/vanillaExtractPlugin";
import {
  cssBundleEntryModulePlugin,
  cssBundleEntryModuleId,
} from "./plugins/cssBundleEntryModulePlugin";
import { writeFileSafe } from "./utils/fs";
import invariant from "../invariant";
import { hmrPlugin } from "./plugins/hmrPlugin";

export type BrowserCompiler = {
  // produce ./public/build/
  compile: (
    manifestChannel: WriteChannel<AssetsManifest>
  ) => Promise<unknown[] | undefined>;
  dispose: () => void;
};

const getExternals = (remixConfig: RemixConfig): string[] => {
  // For the browser build, exclude node built-ins that don't have a
  // browser-safe alternative installed in node_modules. Nothing should
  // *actually* be external in the browser build (we want to bundle all deps) so
  // this is really just making sure we don't accidentally have any dependencies
  // on node built-ins in browser bundles.
  let dependencies = Object.keys(getAppDependencies(remixConfig));
  let fakeBuiltins = nodeBuiltins.filter((mod) => dependencies.includes(mod));

  if (fakeBuiltins.length > 0) {
    throw new Error(
      `It appears you're using a module that is built in to node, but you installed it as a dependency which could cause problems. Please remove ${fakeBuiltins.join(
        ", "
      )} before continuing.`
    );
  }
  return nodeBuiltins.filter((mod) => !dependencies.includes(mod));
};

const writeAssetsManifest = async (
  config: RemixConfig,
  assetsManifest: AssetsManifest
) => {
  let filename = `manifest-${assetsManifest.version.toUpperCase()}.js`;

  assetsManifest.url = config.publicPath + filename;

  await writeFileSafe(
    path.join(config.assetsBuildDirectory, filename),
    `window.__remixManifest=${JSON.stringify(assetsManifest)};`
  );
};

const isCssBundlingEnabled = (config: RemixConfig) =>
  config.future.unstable_cssModules ||
  config.future.unstable_cssSideEffectImports ||
  config.future.unstable_vanillaExtract;

const createEsbuildConfig = (
  build: "app" | "css",
  config: RemixConfig,
  options: CompileOptions
): esbuild.BuildOptions | esbuild.BuildIncremental => {
  let isCssBuild = build === "css";
  let entryPoints: esbuild.BuildOptions["entryPoints"];

  if (isCssBuild) {
    entryPoints = {
      "css-bundle": cssBundleEntryModuleId,
    };
  } else {
    entryPoints = {
      "entry.client": path.resolve(config.appDirectory, config.entryClientFile),
    };

    for (let id of Object.keys(config.routes)) {
      // All route entry points are virtual modules that will be loaded by the
      // browserEntryPointsPlugin. This allows us to tree-shake server-only code
      // that we don't want to run in the browser (i.e. action & loader).
      entryPoints[id] = config.routes[id].file + "?browser";
    }
  }

  let { mode } = options;
  let outputCss = isCssBuild;

  let plugins: esbuild.Plugin[] = [
    deprecatedRemixPackagePlugin(options.onWarning),
    isCssBundlingEnabled(config) && isCssBuild
      ? cssBundleEntryModulePlugin(config)
      : null,
    config.future.unstable_cssModules
      ? cssModulesPlugin({ config, mode, outputCss })
      : null,
    config.future.unstable_vanillaExtract
      ? vanillaExtractPlugin({ config, mode, outputCss })
      : null,
    config.future.unstable_cssSideEffectImports
      ? cssSideEffectImportsPlugin({ config, options })
      : null,
    cssFilePlugin({ config, options }),
    urlImportsPlugin(),
    mdxPlugin(config),
    browserRouteModulesPlugin(config, /\?browser$/),
    emptyModulesPlugin(config, /\.server(\.[jt]sx?)?$/),
    NodeModulesPolyfillPlugin(),
  ].filter(isNotNull);

  if (mode === "development") {
    // TODO do this for all deps in package.json
    entryPoints["react"] = "react";
    entryPoints["react-dom"] = "react-dom";
    entryPoints["react-dom/client"] = "react-dom/client";
    entryPoints["react-refresh/runtime"] = "react-refresh/runtime";
    // entryPoints["remix:hmr"] = "remix:hmr";
    plugins.push(hmrPlugin({ remixConfig: config }));
  }

  return {
    entryPoints,
    outdir: config.assetsBuildDirectory,
    platform: "browser",
    format: "esm",
    external: [
      // This allows Vanilla Extract to bundle asset imports, e.g. `import href
      // from './image.svg'` resolves to a string like "/build/_assets/XXXX.svg"
      // which will then appear in the compiled CSS, e.g. `background:
      // url("/build/_assets/XXXX.svg")`. If we don't mark this path as
      // external, esbuild will try to bundle it again but won't find it.
      config.future.unstable_vanillaExtract
        ? `${config.publicPath}_assets/*`
        : null,
      ...getExternals(config),
    ].filter(isNotNull),
    loader: loaders,
    bundle: true,
    logLevel: "silent",
    splitting: !isCssBuild,
    sourcemap: options.sourcemap,
    // As pointed out by https://github.com/evanw/esbuild/issues/2440, when tsconfig is set to
    // `undefined`, esbuild will keep looking for a tsconfig.json recursively up. This unwanted
    // behavior can only be avoided by creating an empty tsconfig file in the root directory.
    tsconfig: config.tsconfigPath,
    mainFields: ["browser", "module", "main"],
    treeShaking: true,
    minify: options.mode === "production",
    entryNames: "[dir]/[name]-[hash]",
    chunkNames: "_shared/[name]-[hash]",
    assetNames: "_assets/[name]-[hash]",
    publicPath: config.publicPath,
    define: {
      "process.env.NODE_ENV": JSON.stringify(options.mode),
      "process.env.REMIX_DEV_SERVER_WS_PORT": JSON.stringify(
        config.devServerPort
      ),
    },
    jsx: "automatic",
    jsxDev: options.mode !== "production",
    plugins,
    supported: {
      "import-meta": true,
    },
  };
};

export const createBrowserCompiler = (
  remixConfig: RemixConfig,
  options: CompileOptions
): BrowserCompiler => {
  let appCompiler: esbuild.BuildIncremental;
  let cssCompiler: esbuild.BuildIncremental;
  let prevMetafile: esbuild.Metafile;
  let prevAssetsManifest: AssetsManifest;
  let compile = async (manifestChannel: WriteChannel<AssetsManifest>) => {
    try {
      let appBuildTask = async () => {
        appCompiler = await (!appCompiler
          ? esbuild.build({
              ...createEsbuildConfig("app", remixConfig, options),
              metafile: true,
              incremental: true,
            })
          : appCompiler.rebuild());

        invariant(
          appCompiler.metafile,
          "Expected app compiler metafile to be defined. This is likely a bug in Remix. Please open an issue at https://github.com/remix-run/remix/issues/new"
        );
        return appCompiler.metafile;
      };

      let cssBuildTask = async () => {
        if (!isCssBundlingEnabled(remixConfig)) {
          return;
        }

        // The types aren't great when combining write: false and incremental: true
        //  so we need to assert that it's an incremental build
        cssCompiler = (await (!cssCompiler
          ? esbuild.build({
              ...createEsbuildConfig("css", remixConfig, options),
              metafile: true,
              incremental: true,
              write: false,
            })
          : cssCompiler.rebuild())) as esbuild.BuildIncremental;

        invariant(
          cssCompiler.metafile,
          "Expected CSS compiler metafile to be defined. This is likely a bug in Remix. Please open an issue at https://github.com/remix-run/remix/issues/new"
        );

        let outputFiles = cssCompiler.outputFiles || [];

        let isCssBundleFile = (
          outputFile: esbuild.OutputFile,
          extension: ".css" | ".css.map"
        ): boolean => {
          return (
            path.dirname(outputFile.path) ===
              remixConfig.assetsBuildDirectory &&
            path.basename(outputFile.path).startsWith("css-bundle") &&
            outputFile.path.endsWith(extension)
          );
        };

        let cssBundleFile = outputFiles.find((outputFile) =>
          isCssBundleFile(outputFile, ".css")
        );

        if (!cssBundleFile) {
          return;
        }

        let cssBundlePath = cssBundleFile.path;

        let { css, map } = await postcss([
          // We need to discard duplicate rules since "composes"
          // in CSS Modules can result in duplicate styles
          postcssDiscardDuplicates(),
        ]).process(cssBundleFile.text, {
          from: cssBundlePath,
          to: cssBundlePath,
          map: options.sourcemap && {
            prev: outputFiles.find((outputFile) =>
              isCssBundleFile(outputFile, ".css.map")
            )?.text,
            inline: false,
            annotation: false,
            sourcesContent: true,
          },
        });

        await fse.ensureDir(path.dirname(cssBundlePath));

        await Promise.all([
          fse.writeFile(cssBundlePath, css),
          options.mode !== "production" && map
            ? fse.writeFile(`${cssBundlePath}.map`, map.toString()) // Write our updated source map rather than esbuild's
            : null,
          ...outputFiles
            .filter((outputFile) => !/\.(css|js|map)$/.test(outputFile.path))
            .map(async (asset) => {
              await fse.ensureDir(path.dirname(asset.path));
              await fse.writeFile(asset.path, asset.contents);
            }),
        ]);

        // Return the CSS bundle path so we can use it to generate the manifest
        return cssBundlePath;
      };

      let [cssBundlePath, metafile] = await Promise.all([
        cssBuildTask(),
        appBuildTask(),
      ]);

      let timestamp = Date.now();
      let manifest = await createAssetsManifest({
        config: remixConfig,
        metafile: appCompiler.metafile!,
        cssBundlePath,
        timestamp: options.mode === "development" ? timestamp : undefined,
      });
      manifestChannel.write(manifest);
      await writeAssetsManifest(remixConfig, manifest);

      let shouldReload = false;
      let newRouteIds = new Set(Object.keys(manifest.routes));
      let oldRouteIds = new Set(Object.keys(prevAssetsManifest?.routes ?? {}));
      let routeIds = new Set([...newRouteIds, ...oldRouteIds]);
      for (let rid of routeIds) {
        // any new not in old -> added -> reload
        if (!newRouteIds.has(rid)) {
          shouldReload = true;
          break;
        }
        // any old routes not in new -> removed -> full reload
        if (!oldRouteIds.has(rid)) {
          shouldReload = true;
          break;
        }
        // any false->true has loader (hasloader)
        let prevRoute = prevAssetsManifest.routes[rid];
        let route = manifest.routes[rid];
        if (!prevRoute.hasLoader && route.hasLoader) {
          shouldReload = true;
          break;
        }
      }

      if (shouldReload) {
        prevAssetsManifest = manifest;
        return;
      }
      prevAssetsManifest = manifest;

      if (prevMetafile !== undefined) {
        manifest.entry.module = manifest.entry.module + `?t=${timestamp}`;
        manifest.entry.imports = manifest.entry.imports.map(
          (imp) => imp + `?t=${timestamp}`
        );
        for (let routeId of Object.keys(manifest.routes)) {
          let route = manifest.routes[routeId];
          manifest.routes[routeId] = {
            ...route,
            module: route.module + `?t=${timestamp}`,
            imports: (route.imports ?? []).map(
              (imp) => imp + `?t=${timestamp}`
            ),
          };
        }
        let create_input2output = (
          metafile: esbuild.Metafile
        ): Record<string, string> => {
          let inputs = new Set(Object.keys(metafile.inputs));
          let input2output: Record<string, string> = {};
          for (let [outputPath, output] of Object.entries(metafile.outputs)) {
            for (let x of Object.keys(output.inputs)) {
              if (inputs.has(x)) {
                input2output[x] = outputPath + `?t=${timestamp}`;
              }
            }
          }
          return input2output;
        };
        let updates = [];
        let prev_i2o = create_input2output(prevMetafile);
        let i2o = create_input2output(metafile);
        for (let input of Object.keys(metafile.inputs)) {
          let prev_o = prev_i2o[input];
          let o = i2o[input];
          if (prev_o !== o) {
            let url =
              remixConfig.publicPath +
              path.relative(remixConfig.assetsBuildDirectory, path.resolve(o));
            let id = input;
            if (id.startsWith("browser-route-module:")) {
              id = path.relative(
                remixConfig.rootDirectory,
                path.join(
                  remixConfig.appDirectory,
                  id
                    .replace(/^browser-route-module:/, "")
                    .replace(/\?browser$/, "")
                )
              );
            }
            updates.push({
              id,
              url,
            });
          }
        }
        prevMetafile = metafile;
        return updates;
      }
      prevMetafile = metafile;
    } catch (reason) {
      console.error("HMR update failed", reason);
    }
  };

  return {
    compile,
    dispose: () => {
      appCompiler?.rebuild.dispose();
      cssCompiler?.rebuild.dispose();
    },
  };
};

function isNotNull<Value>(value: Value): value is Exclude<Value, null> {
  return value !== null;
}
