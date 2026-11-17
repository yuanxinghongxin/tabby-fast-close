const path = require('path')

module.exports = {
    mode: 'production',
    devtool: false,
    entry: './src/index.ts',
    target: 'node',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        library: { type: 'umd' },
        globalObject: 'global',
    },
    externals: [
        /^@angular\//,
        /^rxjs(\/.*)?$/,
        /^tabby-/,
        'child_process', 'fs', 'os', 'path', 'electron',
    ],
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        configFile: path.resolve(__dirname, 'tsconfig.json'),
                        transpileOnly: true,
                    },
                },
                exclude: /node_modules/,
            },
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
}
