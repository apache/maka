/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

{
  description = "apache maka";

  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.zst";
  };

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    # credit to: https://ayats.org/blog/no-flake-utils
    forAllSystems = function:
      nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ] (
        system:
          function rec {
            inherit system;
            pkgs = import nixpkgs {
              inherit system;
            };
            electron = pkgs.electron_43;
            nativeBuildInputs =
              [
                electron
                pkgs.nodejs_24
                pkgs.ripgrep
                pkgs.rustc
                pkgs.cargo
              ]
              ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isDarwin pkgs.apple-sdk;
          }
      );

    apache-maka = {
      pkgs,
      electron,
      nativeBuildInputs,
      ...
    }:
      pkgs.buildNpmPackage (finalAttrs: {
        name = "apache-maka";
        src = ./.;

        nativeBuildInputs =
          nativeBuildInputs
          ++ [
            pkgs.rustPlatform.cargoSetupHook
            pkgs.makeWrapper
          ];

        npmDepsHash = "sha256-uk7emVa4eI5O5WvfRKjPQD3FuWV1JwLG5Az6gF+kWDM=";

        env = {
          ELECTRON_SKIP_BINARY_DOWNLOAD = 1;
        };

        npmFlags = ["--ignore-scripts"];
        dontNpmBuild = true;

        cargoRoot = "native/runtime-host-peer";
        cargoDeps = pkgs.rustPlatform.importCargoLock {
          lockFile = ./native/runtime-host-peer/Cargo.lock;
          outputHashes = {
            "rtc-0.21.0-rc.1" = "sha256-3zDb+x2IhHBMh8tfumteDE5JG/zZacaevbSCkcqDZk0=";
          };
        };

        buildPhase = ''
          node scripts/apply-dependency-patches.mjs

          npm run build
          npm run build:runtime-host-peer

          ${
            if pkgs.stdenv.hostPlatform.isDarwin
            then ''
              echo "Not implemented"
            ''
            else if pkgs.stdenv.hostPlatform.isAarch64
            then ''
              npm --workspace @maka/desktop exec electron-builder -- \
                --config electron-builder.config.mjs \
                --linux dir \
                --arm64 \
                --publish never \
                -c.electronDist=${electron.dist} \
                -c.electronVersion=${electron.version}
            ''
            else ''
              npm --workspace @maka/desktop exec electron-builder -- \
                --config electron-builder.config.mjs \
                --linux dir \
                --x64 \
                --publish never \
                -c.electronDist=${electron.dist} \
                -c.electronVersion=${electron.version}
            ''
          }
        '';

        installPhase = ''
          mkdir -p $out/share
          cp -r apps/desktop/release/*-unpacked/{locales,resources{,.pak}} $out/share

          makeWrapper ${pkgs.lib.getExe electron} $out/bin/maka \
            --add-flags $out/share/resources/app.asar \
            --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}"

          install -m 444 -D $out/share/resources/assets/icon.png \
            $out/share/icons/hicolor/1024x1024/apps/apache-maka.png
        '';
      });
  in {
    packages = forAllSystems (args: {
      default = apache-maka args;
      apache-maka = apache-maka args;
    });

    overlays.default = final: prev: {
      apache-maka = self.packages.${final.stdenv.hostPlatform.system}.default;
    };

    apps = forAllSystems ({system, ...}: rec {
      default = apache-maka;
      apache-maka = {
        type = "app";
        program = "${self.packages.${system}.default}/bin/maka";
      };
    });

    devShells = forAllSystems ({
      pkgs,
      electron,
      nativeBuildInputs,
      ...
    }: {
      default = pkgs.mkShell {
        ELECTRON_SKIP_BINARY_DOWNLOAD = 1;
        ELECTRON_OVERRIDE_DIST_PATH = "${electron}/bin";

        shellHook = ''
          npm ci
        '';
        packages = nativeBuildInputs ++ [ pkgs.biome ];
      };
    });

    formatter = forAllSystems ({pkgs, ...}: pkgs.alejandra);
  };
}
