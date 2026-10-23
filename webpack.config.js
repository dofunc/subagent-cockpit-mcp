import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import webpack from 'webpack'
import CopyWebpackPlugin from 'copy-webpack-plugin'
import HtmlWebpackPlugin from 'html-webpack-plugin'
import MiniCssExtractPlugin from 'mini-css-extract-plugin'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(dirname, 'package.json'), 'utf-8'))

export default [
  {
    name: 'node',
    // The ACP adapters ship inside dist/, so the package has no runtime dependencies
    entry: {
      cli: './src/cli.ts',
      'claude-agent-acp': '@agentclientprotocol/claude-agent-acp/dist/index.js',
      // Our own ACP bridge over `agy -p`
      'agy-acp': './src/bridge/agy-acp.ts',
      // Our own ACP bridge over `pi --mode rpc`
      'pi-acp': './src/bridge/pi-acp.ts',
      // The webui process, started by the first MCP server that finds no webui on the port
      webui: './src/webui/server.ts',
    },
    target: 'node22',
    mode: 'production',
    module: {
      // Keep import.meta.url and createRequire for runtime: bundledPath() locates files next to dist/cli.js
      parser: { javascript: { importMeta: false, createRequire: false } },
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js'],
      extensionAlias: {
        '.js': ['.ts', '.js'],
      },
    },
    experiments: { outputModule: true },
    output: {
      filename: '[name].js',
      chunkFilename: 'chunks/[id].js',
      path: path.resolve(dirname, 'dist'),
      // dist/html/ belongs to the web build, which runs alongside this one
      clean: { keep: /^html\// },
      module: true,
      chunkFormat: 'module',
      library: { type: 'module' },
    },
    optimization: {
      minimize: false,
    },
    plugins: [
      // codex-acp already ships as a single ESM file importing only node: built-ins
      new CopyWebpackPlugin({
        patterns: [{ from: 'node_modules/@agentclientprotocol/codex-acp/dist/index.js', to: 'codex-acp.js' }],
      }),
      new webpack.DefinePlugin({
        __VERSION__: JSON.stringify(pkg.version),
      }),
      // ws tries these optional native addons and falls back to plain JS when the require throws
      new webpack.IgnorePlugin({ resourceRegExp: /^(bufferutil|utf-8-validate)$/ }),
      new webpack.BannerPlugin({
        banner: '#!/usr/bin/env node',
        raw: true,
        entryOnly: true,
        test: /cli\.js$/,
      }),
    ],
  },
  {
    name: 'web',
    target: 'web',
    mode: 'production',
    entry: { main: './src/webui/app/main.ts' },
    module: {
      rules: [
        { test: /\.tsx?$/, use: { loader: 'ts-loader', options: { configFile: 'tsconfig.app.json' } }, exclude: /node_modules/ },
        { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
        // Platform marks, inlined as data URIs
        { test: /\.svg$/, type: 'asset/inline' },
      ],
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    },
    output: {
      filename: 'assets/[name].[contenthash].js',
      path: path.resolve(dirname, 'dist/html'),
      // Relative URLs, so the page works under whatever path serves it
      publicPath: '',
      clean: true,
    },
    plugins: [
      new HtmlWebpackPlugin({ title: 'subagent-cockpit' }),
      new MiniCssExtractPlugin({ filename: 'assets/[name].[contenthash].css' }),
      // CodeHighlighter loads each language lazily, about 300 chunks; one file keeps dist/html small to ship
      new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    ],
  },
]
