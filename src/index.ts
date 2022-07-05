import { Sonos, DeviceDiscovery } from 'sonos';
import { resolve } from 'path';
import fs from 'fs'
import http from 'http'
import ip from 'ip'

import type { Group } from './types';

let port = process.env.PORT || 5050;

function stat(path: string): Promise<fs.Stats> {
  return new Promise((resolve, reject) =>
    fs.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
  );
}

function getDevices(): Promise<Group[]> {
  return new Promise(resolve => {
    // @ts-expect-error
    DeviceDiscovery().once('DeviceAvailable', async (device) => {
      let sonos = new Sonos(device.host, device.port, null);
      let groups = await sonos.getAllGroups();
      resolve(groups);
    });
  })
}

async function ring(ip: string, port: string | number, device: Group) {
  let sonos = new Sonos(device.host, device.port, null);
  let state = await sonos.getCurrentState();
  let volume = await sonos.getVolume();
  let wasPlaying = (state === 'playing' || state === 'transitioning')
  let mediaInfo = await sonos.avTransportService().GetMediaInfo()
  let positionInfo = await sonos.avTransportService().GetPositionInfo()

  let info = { name: device.Name, rang: false, uri: mediaInfo.CurrentURI, state, volume, errors: [] }
  let error = (msg: string) => () => info.errors.push(msg)
  
  // skip devices playing doorbell or TV stream
  if (wasPlaying && mediaInfo.CurrentURI?.startsWith(`http://${ip}`)) return info;
  if (wasPlaying && mediaInfo.CurrentURI?.startsWith(`x-sonos-htastream`)) return info;

  await sonos.setVolume(60);
  await sonos.setAVTransportURI({ uri: `http://${ip}:${port}/clips/doorbell.mp3` })
  info.rang = true;

  // Wait for the doorbell sound to finish
  await new Promise(resolve => setTimeout(resolve, 7000));
  await sonos.setVolume(volume);

  // following doesnt work with spotify :(
  await sonos.setAVTransportURI({ uri: mediaInfo.CurrentURI, metadata: mediaInfo.CurrentURIMetaData, onlySetUri: true })
    .catch(error('Reverting media failed.'))

  if (positionInfo.Track && positionInfo.Track > 1 && mediaInfo.NrTracks > 1) {
    await sonos.selectTrack(positionInfo.Track).catch(error('Reverting back track failed.'))
  }

  if (positionInfo.RelTime && positionInfo.TrackDuration !== '0:00:00') {
    await sonos.avTransportService().Seek({ InstanceID: 0, Unit: 'REL_TIME', Target: positionInfo.RelTime })
      .catch(error('Reverting back track time failed.'))
  }

  if (wasPlaying) {
    // @ts-expect-error
    await sonos.play().catch(error('Resuming playback failed.'))
  }

  return info
}

async function run() {
  let localAddress = ip.address();
  let devices = await getDevices();

  let server = http.createServer(async function serve(req, res) {

    if (req.url.endsWith('/ring')) {
      res.statusCode = 200;
      let results = await Promise.all(devices.map(device => ring(localAddress, port, device)));
      let str = JSON.stringify(results, null, 2);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
	    res.setHeader('Content-Length', Buffer.byteLength(str));
	    res.end(str);
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
  });

  server.listen(port);
  console.log(`Sonos Doorbell API available on: http://${localAddress}:${port}`);
}

run();