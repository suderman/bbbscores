self: { config, lib, pkgs, ... }: let
  cfg = config.services.bbbscores;
in {
  options.services.bbbscores = {
    enable = lib.mkEnableOption "the Boom Boom Baby high-score service";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "bbbscores package to run.";
    };
    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Listen address. Keep loopback when using a local reverse proxy.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "HTTP listen port. No firewall port is opened by this module.";
    };
    allowedOrigins = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "https://game1.boomboombaby.ca"
        "https://game2.boomboombaby.ca"
        "https://boomboombaby.ca"
        "https://*.itch.zone"
      ];
      description = "CORS origins. Scheme-specific wildcard subdomains are supported.";
    };
    clientIpHeader = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Optional single-IP header set by a trusted loopback reverse proxy for rate limits.";
    };
    rateLimit = lib.mkOption {
      type = lib.types.ints.between 1 1000000;
      default = 10;
      description = "POST attempts allowed per client IP across both boards in each window.";
    };
    rateWindowMs = lib.mkOption {
      type = lib.types.ints.between 1 86400000;
      default = 60000;
      description = "Submission rate-limit window in milliseconds.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.bbbscores = {};
    users.users.bbbscores = {
      isSystemUser = true;
      group = "bbbscores";
      home = "/var/lib/bbbscores";
    };
    environment.systemPackages = [ cfg.package ];
    systemd.services.bbbscores = {
      description = "Boom Boom Baby high scores";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        ALLOWED_ORIGINS = lib.concatStringsSep "," cfg.allowedOrigins;
        CLIENT_IP_HEADER = cfg.clientIpHeader;
        RATE_LIMIT = toString cfg.rateLimit;
        RATE_WINDOW_MS = toString cfg.rateWindowMs;
      };
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package} serve";
        User = "bbbscores";
        Group = "bbbscores";
        StateDirectory = "bbbscores";
        StateDirectoryMode = "0700";
        WorkingDirectory = "/var/lib/bbbscores";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStopSec = 30;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        LockPersonality = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        TasksMax = 64;
        MemoryMax = "256M";
      };
    };
  };
}
