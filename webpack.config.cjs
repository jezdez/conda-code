const path = require('node:path');

/** @type {import('webpack').ConfigurationFactory} */
module.exports = (_env, argv) => ({
  target: 'node',
  entry: './src/extension.ts',
  mode: argv.mode ?? 'none',
  devtool: argv.mode === 'production' ? false : 'source-map',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    clean: true,
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: 'ts-loader',
      },
    ],
  },
  performance: {
    hints: false,
  },
});
