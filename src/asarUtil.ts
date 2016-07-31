import { AsarFileInfo, listPackage, statFile, AsarOptions } from "asar-electron-builder"
import { statOrNull, debug } from "./util/util"
import {
  lstat, readdir, readFile, Stats, createWriteStream, ensureDir, createReadStream, readJson,
  writeFile
} from "fs-extra-p"
import { Promise as BluebirdPromise } from "bluebird"
import * as path from "path"
import pathSorter = require("path-sort")
import { log } from "./util/log"
import { Minimatch } from "minimatch"

const isBinaryFile: any = BluebirdPromise.promisify(require("isbinaryfile"))
const pickle = require ("chromium-pickle-js")
const Filesystem = require("asar-electron-builder/lib/filesystem")
const UINT64 = require("cuint").UINT64

//noinspection JSUnusedLocalSymbols
const __awaiter = require("./util/awaiter")

const MAX_FILE_REQUESTS = 32
const concurrency = {concurrency: MAX_FILE_REQUESTS}
const NODE_MODULES_PATTERN = path.sep + "node_modules" + path.sep

function walk(dirPath: string, consumer: (file: string, stat: Stats) => void, filter: (file: string) => boolean, addRootToResult?: boolean): BluebirdPromise<Array<string>> {
  return readdir(dirPath)
    .then(names => {
      return BluebirdPromise.map(names, name => {
        const filePath = dirPath + path.sep + name
        if (!filter(filePath)) {
          return <any>null
        }

        return lstat(filePath)
          .then((stat): any => {
            consumer(filePath, stat)
            if (stat.isDirectory()) {
              return walk(filePath, consumer, filter, true)
            }
            return filePath
          })
      }, concurrency)
    })
    .then(list => {
      list.sort((a, b) => {
        // files before directories
        if (Array.isArray(a) && Array.isArray(b)) {
          return 0
        }
        else if (a == null || Array.isArray(a)) {
          return 1
        }
        else if (b == null || Array.isArray(b)) {
          return -1
        }
        else {
          return a.localeCompare(b)
        }
      })

      const result: Array<string> = addRootToResult ? [dirPath] : []
      for (let item of list) {
        if (item != null) {
          if (Array.isArray(item)) {
            result.push.apply(result, item)
          }
          else {
            result.push(item)
          }
        }
      }
      return result
    })
}

export async function createAsarArchive(src: string, resourcesPath: string, options: AsarOptions, filter: (file: string) => boolean): Promise<any> {
  const metadata = new Map<string, Stats>()
  const files = await walk(src, (it, stat) => {
    metadata.set(it, stat)
  }, filter)

  // sort files to minimize file change (i.e. asar file is not changed dramatically on small change)
  await createPackageFromFiles(src, path.join(resourcesPath, "app.asar"), options.ordering == null ? files : await order(src, files, options), metadata, options)
}

function isUnpackDir(path: string, pattern: Minimatch, rawPattern: string): boolean {
  return path.indexOf(rawPattern) === 0 || pattern.match(path)
}

async function order(src: string, filenames: Array<string>, options: any) {
  const orderingFiles = (await readFile(options.ordering, "utf8")).split("\n").map(function (line) {
    if (line.indexOf(':') !== -1) {
      line = line.split(':').pop()!
    }
    line = line.trim()
    if (line[0] === '/') {
      line = line.slice(1)
    }
    return line
  })

  const ordering: Array<string> = []
  for (let file of orderingFiles) {
    let pathComponents = file.split(path.sep)
    let str = src
    for (let pathComponent of pathComponents) {
      str = path.join(str, pathComponent)
      ordering.push(str)
    }
  }

  const filenamesSorted: Array<string> = []
  let missing = 0
  const total = filenames.length
  for (let file of ordering) {
    if (!filenamesSorted.includes(file) && filenames.includes(file)) {
      filenamesSorted.push(file)
    }
  }
  for (let file of filenames) {
    if (!filenamesSorted.includes(file)) {
      filenamesSorted.push(file)
      missing += 1;
    }
  }
  log(`Ordering file has ${((total - missing) / total * 100)}% coverage.`)
  return filenamesSorted
}

async function detectUnpackedDirs(src: string, files: Array<string>, metadata: Map<string, Stats>, autoUnpackDirs: Set<string>, createDirPromises: Array<Promise<any>>, unpackedDest: string, fileIndexToModulePackageData: Array<BluebirdPromise<string>>) {
  const packageJsonStringLength = "package.json".length
  const readPackageJsonPromises: Array<Promise<any>> = []
  for (let i = 0, n = files.length; i < n; i++) {
    const file = files[i]
    const index = file.lastIndexOf(NODE_MODULES_PATTERN)
    if (index < 0) {
      continue
    }

    const nextSlashIndex = file.indexOf(path.sep, index + NODE_MODULES_PATTERN.length + 1)
    if (nextSlashIndex < 0) {
      continue
    }

    if (!metadata.get(file)!.isFile()) {
      continue
    }

    const nodeModuleDir = file.substring(0, nextSlashIndex)

    if (file.length == (nodeModuleDir.length + 1 + packageJsonStringLength) && file.endsWith("package.json")) {
      const promise = readJson(file)

      if (readPackageJsonPromises.length > MAX_FILE_REQUESTS) {
        await BluebirdPromise.all(readPackageJsonPromises)
        readPackageJsonPromises.length = 0
      }
      readPackageJsonPromises.push(promise)
      fileIndexToModulePackageData[i] = promise
    }

    if (autoUnpackDirs.has(nodeModuleDir)) {
      const fileParent = path.dirname(file)
      if (fileParent != nodeModuleDir && !autoUnpackDirs.has(fileParent)) {
        autoUnpackDirs.add(fileParent)

        if (createDirPromises.length > MAX_FILE_REQUESTS) {
          await BluebirdPromise.all(createDirPromises)
          createDirPromises.length = 0
        }
        createDirPromises.push(ensureDir(path.join(unpackedDest, path.relative(src, fileParent))))
      }
      continue
    }

    const ext = path.extname(file)
    let shouldUnpack = false
    if (ext === ".dll" || ext === ".exe") {
      shouldUnpack = true
    }
    else if (ext === "") {
      shouldUnpack = await isBinaryFile(file)
    }

    if (!shouldUnpack) {
      continue
    }

    log(`${path.relative(src, nodeModuleDir)} is not packed into asar archive - contains executable code`)
    autoUnpackDirs.add(nodeModuleDir)
    const fileParent = path.dirname(file)
    if (fileParent != nodeModuleDir) {
      autoUnpackDirs.add(fileParent)
      // create parent dir to be able to copy file later without directory existence check
      createDirPromises.push(ensureDir(path.join(unpackedDest, path.relative(src, fileParent))))
    }
  }

  if (readPackageJsonPromises.length > 0) {
    await BluebirdPromise.all(readPackageJsonPromises)
  }
  if (createDirPromises.length > 0) {
    await BluebirdPromise.all(createDirPromises)
    createDirPromises.length = 0
  }
}

async function createPackageFromFiles(src: string, dest: string, files: Array<string>, metadata: Map<string, Stats>, options: AsarOptions) {
  // search auto unpacked dir
  const autoUnpackDirs = new Set<string>()

  const createDirPromises: Array<Promise<any>> = [ensureDir(path.dirname(dest))]
  const unpackedDest = `${dest}.unpacked`
  const changedFiles = new Map<string, string>()

  const fileIndexToModulePackageData: Array<BluebirdPromise<string>> = new Array(files.length)
  if (options.smartUnpack !== false) {
    await detectUnpackedDirs(src, files, metadata, autoUnpackDirs, createDirPromises, unpackedDest, fileIndexToModulePackageData)
  }

  const unpackDir = options.unpackDir == null ? null : new Minimatch(options.unpackDir)
  const unpack = options.unpack == null ? null : new Minimatch(options.unpack, {
    matchBase: true
  })

  const toPack: Array<string> = []
  const filesystem = new Filesystem(src)
  const copyPromises: Array<Promise<any>> = []
  const mainPackageJson = path.join(src, "package.json")
  for (let i = 0, n = files.length; i < n; i++) {
    const file = files[i]
    const stat = metadata.get(file)!
    if (stat.isFile()) {
      const fileParent = path.dirname(file)
      const dirNode = filesystem.searchNodeFromPath(fileParent)

      if (dirNode.unpacked && createDirPromises.length > 0) {
        await BluebirdPromise.all(createDirPromises)
        createDirPromises.length = 0
      }

      const packageDataPromise = fileIndexToModulePackageData[i]
      let newData: any | null = null
      if (packageDataPromise == null) {
        if (options.extraMetadata != null && file === mainPackageJson) {
          newData = JSON.stringify(Object.assign(await readJson(file), options.extraMetadata), null, 2)
        }
      }
      else {
        newData = cleanupPackageJson(packageDataPromise.value())
      }

      const fileSize = newData == null ? stat.size : Buffer.byteLength(newData)
      const node = filesystem.searchNodeFromPath(file)
      node.size = fileSize
      if (dirNode.unpacked || (unpack != null && unpack.match(file))) {
        node.unpacked = true

        if (!dirNode.unpacked) {
          createDirPromises.push(ensureDir(path.join(unpackedDest, path.relative(src, fileParent))))
          await BluebirdPromise.all(createDirPromises)
          createDirPromises.length = 0
        }

        const unpackedFile = path.join(unpackedDest, path.relative(src, file))
        copyPromises.push(newData == null ? copyFile(file, unpackedFile, stat) : writeFile(unpackedFile, newData))
        if (copyPromises.length > MAX_FILE_REQUESTS) {
          await BluebirdPromise.all(copyPromises)
          copyPromises.length = 0
        }
      }
      else {
        if (newData != null) {
          changedFiles.set(file, newData)
        }

        if (fileSize > 4294967295) {
          throw new Error(`${file}: file size can not be larger than 4.2GB`)
        }

        node.offset = filesystem.offset.toString()
        //noinspection JSBitwiseOperatorUsage
        if (process.platform !== "win32" && stat.mode & 0x40) {
          node.executable = true
        }
        toPack.push(file)
      }

      filesystem.offset.add(UINT64(fileSize))
    }
    else if (stat.isDirectory()) {
      let unpacked = false
      if (autoUnpackDirs.has(file)) {
        unpacked = true
      }
      else {
        unpacked = unpackDir != null && isUnpackDir(path.relative(src, file), unpackDir, options.unpackDir!)
        if (unpacked) {
          createDirPromises.push(ensureDir(path.join(unpackedDest, path.relative(src, file))))
        }
        else {
          for (let d of autoUnpackDirs) {
            if (file.length > (d.length + 2) && file[d.length] === path.sep && file.startsWith(d)) {
              unpacked = true
              autoUnpackDirs.add(file)
              // not all dirs marked as unpacked after first iteration - because node module dir can be marked as unpacked after processing node module dir content
              // e.g. node-notifier/example/advanced.js processed, but only on process vendor/terminal-notifier.app module will be marked as unpacked
              createDirPromises.push(ensureDir(path.join(unpackedDest, path.relative(src, file))))
              break
            }
          }
        }
      }
      filesystem.insertDirectory(file, unpacked)
    }
    else if (stat.isSymbolicLink()) {
      filesystem.insertLink(file, stat)
    }
  }

  await BluebirdPromise.all(copyPromises)
  await writeAsarFile(filesystem, dest, toPack, changedFiles)
}

function cleanupPackageJson(data: any): any {
  try {
    let changed = false
    for (let prop of Object.getOwnPropertyNames(data)) {
      if (prop[0] === "_" || prop === "dist" || prop === "gitHead" || prop === "keywords") {
        delete data[prop]
        changed = true
      }
    }

    if (changed) {
      return JSON.stringify(data, null, 2)
    }
  }
  catch (e) {
    debug(e)
  }

  return null
}

function writeAsarFile(filesystem: any, dest: string, toPack: Array<string>, changedFiles: Map<string, string>): Promise<any> {
  const headerPickle = pickle.createEmpty()
  headerPickle.writeString(JSON.stringify(filesystem.header))
  const headerBuf = headerPickle.toBuffer()

  const sizePickle = pickle.createEmpty()
  sizePickle.writeUInt32(headerBuf.length)
  const sizeBuf = sizePickle.toBuffer()

  const writeStream = createWriteStream(dest)
  return new BluebirdPromise((resolve, reject) => {
    writeStream.on("error", reject)
    writeStream.once("finish", resolve)
    writeStream.write(sizeBuf)

    function w(list: Array<any>, index: number) {
      if (list.length === index) {
        writeStream.end()
        return
      }

      const file = list[index]

      const data = changedFiles.get(file)
      if (data != null) {
        writeStream.write(data, () => w(list, index + 1))
        return
      }

      const readStream = createReadStream(file)
      readStream.on("error", reject)
      readStream.once("end", () => w(list, index + 1))
      readStream.pipe(writeStream, {
        end: false
      })
    }

    writeStream.write(headerBuf, () => w(toPack, 0))
  })
}

export async function checkFileInPackage(asarFile: string, relativeFile: string) {
  let stat: AsarFileInfo | null
  try {
    stat = statFile(asarFile, relativeFile)
  }
  catch (e) {
    const fileStat = await statOrNull(asarFile)
    if (fileStat == null) {
      throw new Error(`File "${asarFile}" does not exist. Seems like a wrong configuration.`)
    }

    try {
      listPackage(asarFile)
    }
    catch (e) {
      throw new Error(`File "${asarFile}" is corrupted: ${e}`)
    }

    // asar throws error on access to undefined object (info.link)
    stat = null
  }

  if (stat == null) {
    throw new Error(`Application entry file "${relativeFile}" in the "${asarFile}" does not exist. Seems like a wrong configuration.`)
  }
  if (stat.size === 0) {
    throw new Error(`Application entry file "${relativeFile}" in the "${asarFile}" is corrupted: size 0`)
  }
}

function copyFile(src: string, dest: string, stats: Stats) {
  return new BluebirdPromise(function (resolve, reject) {
    const readStream = createReadStream(src)
    const writeStream = createWriteStream(dest, {mode: stats.mode})

    readStream.on("error", reject)
    writeStream.on("error", reject)

    writeStream.on("open", function () {
      readStream.pipe(writeStream)
    })

    writeStream.once("finish", resolve)
  })
}