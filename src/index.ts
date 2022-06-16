import { Sonos, DeviceDiscovery } from 'sonos';
import { resolve } from 'path';
import fs from 'fs'
import os from 'os';
import http from 'http'

import type { Group, Track } from './types';

let port = process.env.PORT || 5050;

function stat(path: string): Promise<fs.Stats> {
  return new Promise((resolve, reject) =>
    fs.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
  );
}

function getDevices(): Promise<Group[]> {
  return new Promise<Group[]>(resolve => {
    DeviceDiscovery().once('DeviceAvailable', async (device) => {
      let sonos = new Sonos(device.host, device.port, null);
      let groups = await sonos.getAllGroups();
      resolve(groups);
    });
  })
}

function getLocalAddress() {
  let interfaces = os.networkInterfaces();
  let endpoints: string[] = [];
  
  for (var name in interfaces) {
    interfaces[name]
      .filter((ipInfo) => ipInfo.internal == false && ipInfo.family == 'IPv4')
      .forEach((ipInfo) => endpoints.push(ipInfo.address));
  }

  return endpoints;
}

async function ring(ip: string, port: string | number, device: Group) {
  let sonos = new Sonos(device.host, device.port, null);
  let track: Track = await sonos.currentTrack();
  let state: string = await sonos.getCurrentState();
  let volume: string = await sonos.getVolume();
  let uri = track?.uri;

  console.log(device.Name, track, state, volume);

  // skip devices playing doorbell or TV stream
  if (uri?.startsWith(`http://${ip}`)) return;
  if (uri?.startsWith(`x-sonos-htastream`)) return;
  
  await sonos.setVolume(60);
  await sonos.play(`http://${ip}:${port}/clips/doorbell.mp3`);
  console.log(`${device.Name}: Rang doorbell`);

  // Wait for the doorbell sound to finish
  await new Promise(resolve => setTimeout(resolve, 7000));
  await sonos.setVolume(volume);

  if (state === "playing" && uri) {
    await sonos.play(uri);
    console.log(`${device.Name}: Resume playback`);
  }
}

async function run() {
  let localAddress = getLocalAddress();
  let devices = await getDevices();

  let server = http.createServer(async function serve(req, res) {

    if (req.url.endsWith('/ring')) {
      res.statusCode = 200;
      await Promise.all(devices.map(device => ring(localAddress[0], port, device)))
      res.end();
      return;
    }
  
    if (req.url.endsWith('/doorbell.mp3')) {
      let fullPath = resolve('./doorbell.mp3');
      let stats = await stat(fullPath);
      res.setHeader('Last-Modified', stats.mtime.toUTCString());
      res.setHeader('Cache-Control', 'public, must-revalidate, max-age=0');
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', `${stats.size}`);
      res.statusCode = 200;
      let stream = fs.createReadStream(fullPath);
      stream.pipe(res);
      return;
    }

    res.statusCode = 404;
    res.end();
    return;
  });

  server.listen(port);
  console.log(`Sonos Doorbell API available on: http://${localAddress[0]}:${port}`);
}

run();