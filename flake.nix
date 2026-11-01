{
  description = "Shared high scores for the Boom Boom Baby games";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }: let
    systems = [ "x86_64-linux" "aarch64-linux" ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = self.packages.${system}.bbbscores;
      bbbscores = pkgs.stdenvNoCC.mkDerivation {
        pname = "bbbscores";
        version = "1.0.0";
        src = nixpkgs.lib.cleanSource ./.;
        nativeBuildInputs = [ pkgs.makeWrapper pkgs.nodejs_24 ];
        dontBuild = true;
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          node --test tests/*.test.mjs
          runHook postCheck
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out/lib/bbbscores $out/bin
          cp cli.mjs server.mjs store.mjs $out/lib/bbbscores/
          makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/bbbscores \
            --add-flags "$out/lib/bbbscores/cli.mjs"
          runHook postInstall
        '';
        meta = {
          description = "JSON-backed high scores for Boom Boom Baby";
          mainProgram = "bbbscores";
          platforms = systems;
        };
      };
    });

    devShells = forAllSystems (system: {
      default = nixpkgs.legacyPackages.${system}.mkShell {
        packages = [ nixpkgs.legacyPackages.${system}.nodejs_24 ];
      };
    });

    nixosModules.default = import ./nix/module.nix self;
    nixosModules.bbbscores = self.nixosModules.default;

    checks = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
      evaluated = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          self.nixosModules.default
          {
            system.stateVersion = "26.05";
            services.bbbscores = {
              enable = true;
              port = 4321;
              allowedOrigins = [ "https://probe.example" ];
              clientIpHeader = "x-real-ip";
              rateLimit = 3;
              rateWindowMs = 2000;
            };
          }
        ];
      };
      service = evaluated.config.systemd.services.bbbscores;
    in {
      package = self.packages.${system}.default;
      module = assert service.serviceConfig.StateDirectory == "bbbscores";
        assert service.serviceConfig.ProtectSystem == "strict";
        assert service.environment.PORT == "4321";
        assert service.environment.ALLOWED_ORIGINS == "https://probe.example";
        assert service.environment.CLIENT_IP_HEADER == "x-real-ip";
        assert service.environment.RATE_LIMIT == "3";
        assert service.environment.RATE_WINDOW_MS == "2000";
        pkgs.writeText "bbbscores-unit" evaluated.config.systemd.units."bbbscores.service".text;
    });
  };
}
