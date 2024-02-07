const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fileFromPath } = require("formdata-node/file-from-path");
const archiver = require("archiver");

const dependenciesMods = [
  "Moulberry/NotEnoughUpdates",
  "Skytils/SkytilsMod",
  "hannibal002/SkyHanni",
  "BiscuitDevelopment/SkyblockAddons",
  "Quantizr/DungeonRoomsMod",
];

const getMetadataGithub = async (dependencyMod) => {
  const response = await axios.get(
    `https://api.github.com/repos/${dependencyMod}/releases`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  let latestRelease;
  let latestPrerelease;

  for (const release of response.data) {
    if (!release.draft) {
      if (!release.prerelease && !latestRelease) {
        release.assets.forEach((asset) => {
          if (asset.name.endsWith(".jar")) {
            latestRelease = asset;
          }
        });
      }

      if (!latestPrerelease) {
        release.assets.forEach((asset) => {
          if (asset.name.endsWith(".jar")) {
            latestPrerelease = asset;
          }
        });
      }
    }
  }

  return {
    latestRelease,
    latestPrerelease,
  };
};

const downloadFile = async (fileUrl, outputLocationPath) => {
  if (fs.existsSync(outputLocationPath)) {
    console.log(`File already exists: ${getLocalFilename(outputLocationPath)}`);
    return Promise.resolve(true);
  }

  const writer = fs.createWriteStream(outputLocationPath);
  console.log(`Downloading file: ${getLocalFilename(outputLocationPath)}`);

  return axios
    .get(fileUrl, {
      responseType: "stream",
    })
    .then((response) => {
      //ensure that the user can call `then()` only when the file has
      //been downloaded entirely.

      return new Promise((resolve, reject) => {
        response.data.pipe(writer);
        let error = null;
        writer.on("error", (err) => {
          error = err;
          writer.close();
          console.log(
            `Error during download for file ${getLocalFilename(
              outputLocationPath
            )}`
          );
          reject(err);
        });
        writer.on("close", () => {
          if (!error) {
            console.log(
              `File has been downloaded: ${getLocalFilename(
                outputLocationPath
              )}`
            );
            resolve(true);
          }
          //no need to call the reject here, as it will have been called in the
          //'error' stream;
        });
      });
    });
};

const getLocalFilename = (fileUrl) => {
  return path.relative(__dirname, fileUrl);
};

const getHash = async (file, format) => {
  if (fs.existsSync(`${file}.${format}`)) {
    return fs.readFileSync(`${file}.${format}`, "utf-8");
  }

  return new Promise((resolve, reject) => {
    console.log(`Getting hash ${format} for ${getLocalFilename(file)}`);

    const reader = fs.createReadStream(file);
    const hash = crypto.createHash(format);
    hash.setEncoding("hex");

    reader.on("error", (err) => {
      reader.close();
      hash.end();
      console.log(`Error during hash ${format} calculation`);
      console.log(err);
      reject(err);
    });

    reader.on("end", function () {
      hash.end();
      const result = hash.read();
      fs.writeFileSync(`${file}.${format}`, result, "utf-8");
      console.log(`hash ${format} has been calculated : ${result}`);
      resolve(result);
    });

    // read all file and pipe it (write it) to the hash object
    reader.pipe(hash);
  });
};

const checkIfManifestsUpdated = async (
  dependencyMod,
  manifestFile,
  releaseFile
) => {
  if (
    manifestFile.path !== `mods/${releaseFile.name}` ||
    manifestFile.fileSize !== releaseFile.size
  ) {
    console.log("Updating manifest for " + dependencyMod);

    const filename = path.resolve(__dirname, "temp", releaseFile.name);

    await downloadFile(releaseFile.browser_download_url, filename);

    const sha1 = await getHash(filename, "sha1");
    const sha512 = await getHash(filename, "sha512");

    manifestFile.path = `mods/${releaseFile.name}`;
    manifestFile.fileSize = releaseFile.size;
    manifestFile.hashes = {
      sha1,
      sha512,
    };

    console.log("Manifest has been updated ");
    return manifestFile;
  } else {
    console.log("No need to update manifest for " + dependencyMod);
    return false;
  }
};

const updateManifests = async () => {
  const releaseManifests = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "manifests", "release.json"),
      "utf-8"
    )
  );
  const prereleaseManifests = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "manifests", "prerelease.json"),
      "utf-8"
    )
  );

  if (!fs.existsSync(path.resolve(__dirname, "temp"))) {
    fs.mkdirSync(path.resolve(__dirname, "temp"));
  }

  if (fs.existsSync(path.resolve(__dirname, "temp", "prerelease.version"))) {
    fs.unlinkSync(path.resolve(__dirname, "temp", "prerelease.version"));
  }

  if (fs.existsSync(path.resolve(__dirname, "temp", "release.version"))) {
    fs.unlinkSync(path.resolve(__dirname, "temp", "release.version"));
  }

  let releaseManifestsChangelog = [];
  let prereleaseManifestsChangelog = [];

  for await (const dependencyMod of dependenciesMods) {
    const { latestPrerelease, latestRelease } = await getMetadataGithub(
      dependencyMod
    );

    // Prerelease
    const indexPrereleaseManifest = prereleaseManifests.files.findIndex(
      (manifest) => manifest.downloads[0].includes(dependencyMod)
    );
    const prereleaseManifestFile =
      prereleaseManifests.files[indexPrereleaseManifest];
    const resultPrerelease = await checkIfManifestsUpdated(
      dependencyMod,
      prereleaseManifestFile,
      latestPrerelease
    );

    if (resultPrerelease) {
      prereleaseManifests.files[indexPrereleaseManifest] = resultPrerelease;
      releaseManifestsChangelog.push(
        `Updating ${resultPrerelease.path.replace("mods/", "")}`
      );
    }

    // Release
    const indexReleaseManifest = releaseManifests.files.findIndex((manifest) =>
      manifest.downloads[0].includes(dependencyMod)
    );
    const releaseManifestFile = releaseManifests.files[indexReleaseManifest];

    const resultRelease = await checkIfManifestsUpdated(
      dependencyMod,
      releaseManifestFile,
      latestRelease
    );

    if (resultRelease) {
      releaseManifests.files[indexReleaseManifest] = resultRelease;
      prereleaseManifestsChangelog.push(
        `Updating ${resultRelease.path.replace("mods/", "")}`
      );
    }
  }

  const date = new Date();
  const dateStr = `${date.getFullYear()}.${
    date.getMonth() + 1
  }.${date.getDate()}`;

  if (prereleaseManifestsChangelog.length > 0) {
    prereleaseManifests.versionId = `prerelease-${dateStr}`;
    fs.writeFileSync(
      path.resolve(__dirname, "temp", "prerelease.version"),
      prereleaseManifestsChangelog.join("\n")
    );
    fs.writeFileSync(
      path.resolve(__dirname, "manifests", "prerelease.json"),
      JSON.stringify(prereleaseManifests, null, 2)
    );
  }

  if (releaseManifestsChangelog.length > 0) {
    releaseManifests.versionId = dateStr;
    fs.writeFileSync(
      path.resolve(__dirname, "temp", "release.version"),
      releaseManifestsChangelog.join("\n")
    );
    fs.writeFileSync(
      path.resolve(__dirname, "manifests", "release.json"),
      JSON.stringify(releaseManifests, null, 2)
    );
  }
};

const createPackage = (versionType, versionId) => {
  const manifest = path.resolve(
    __dirname,
    "manifests",
    versionType === "prerelease" ? "prerelease.json" : "release.json"
  );

  const output = fs.createWriteStream(
    path.resolve(__dirname, "temp", `HypixelSkyblock-${versionId}.mrpack`)
  );
  const archive = archiver("zip", {
    zlib: { level: 9 }, // Sets the compression level.
  });

  archive.pipe(output);

  archive.file(manifest, { name: "modrinth.index.json" });

  return archive.finalize();
};

const createRelease = async () => {
  const files = fs.readdirSync(path.resolve(__dirname, "temp"));

  for await (const file of files) {
    if (file.endsWith(".version")) {
      const changelog = fs.readFileSync(
        path.resolve(__dirname, "temp", file),
        "utf-8"
      );

      const manifest = JSON.parse(
        fs.readFileSync(
          path.resolve(
            __dirname,
            "manifests",
            `${file.replace(".version", "")}.json`
          ),
          "utf-8"
        )
      );

      const { versionId } = manifest;

      console.log("Preparing package...");
      await createPackage(file.replace(".version", ""), versionId);
      const packageName = `HypixelSkyblock-${versionId}.mrpack`;
      console.log(
        `Package has been prepared: ${packageName}. Waiting for upload...`
      );

      const form = new FormData();
      form.append("data", {
        name: `Hypixel Skyblock Modpack ${versionId}`,
        version_number: versionId,
        changelog,
        dependencies: manifest.files.map((file) => ({
          file_name: file.path.replace("mods/", ""),
          dependency_type: "embedded",
        })),
        game_versions: ["1.8.9"],
        version_type: file.includes("prerelease") ? "beta" : "release",
        loaders: ["forge"],
        featured: true,
        project_id: "3trQWSoU",
        file_parts: [packageName],
      });
      form.append(
        packageName,
        await fileFromPath(path.resolve(__dirname, "temp", packageName))
      );

      await axios.post("https://api.modrinth.com/v2/version", form, {
        Authorization: process.env.MODRINTH_API_KEY,
        "Content-Type": "multipart/form-data",
        "User-Agent": "McRadane/hypixel-skyblock-modpack/1.0.0",
      });

      console.log(`Package has been uploaded: ${packageName}`);
    }
  }
};

const args = process.argv.slice(2);

if (args[0] === "update") {
  updateManifests();
  return;
}

if (args[0] === "create-release") {
  createRelease();
  return;
}
