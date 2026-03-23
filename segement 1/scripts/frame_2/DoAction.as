function markSndDone()
{
   if(snd.s1_playing)
   {
      snd.s1_playing = 0;
   }
   else if(snd.s2_playing)
   {
      snd.s2_playing = 0;
   }
}
function playVO(sndFileName, doRamp, subID)
{
   var sndObjTarg;
   if(snd.s1_playing && !snd.s1_ramping)
   {
      snd.fadeSnd = 1;
      snd.s1_ramping = 1;
      _level0.bkgd.vo.doRamp = 1;
      sndObjTarg = 2;
   }
   else if(snd.s2_playing && !snd.s2_ramping)
   {
      snd.fadeSnd = 2;
      snd.s2_ramping = 1;
      _level0.bkgd.vo.doRamp = 1;
      sndObjTarg = 1;
   }
   else
   {
      sndObjTarg = 1;
      _root.s1.stop();
   }
   if(sndObjTarg == 1)
   {
      _root.s1.attachSound(sndFileName);
      snd.s1_playing = 1;
      _root.s1.setVolume(_level0.bkgd.VOvol);
      _level0.bkgd.vo.sndTarg = 1;
      if(subID == null)
      {
         _level0.markSnd(sndFileName);
         _level0.bkgd.vo.activeSnd = sndFileName;
      }
      else
      {
         _level0.markSnd(subID);
         _level0.bkgd.vo.activeSnd = subID;
      }
      _root.s1.start();
   }
   else
   {
      _root.s2.attachSound(sndFileName);
      snd.s2_playing = 1;
      _root.s2.setVolume(_level0.bkgd.VOvol);
      _level0.bkgd.vo.sndTarg = 2;
      _level0.bkgd.vo.activeSnd = sndFileName;
      if(subID == null)
      {
         _level0.markSnd(sndFileName);
         _level0.bkgd.vo.activeSnd = sndFileName;
      }
      else
      {
         _level0.markSnd(subID);
         _level0.bkgd.vo.activeSnd = subID;
      }
      _root.s2.start();
   }
}
function rampVOout()
{
   if(snd.s1_playing && !snd.s1_ramping)
   {
      snd.fadeSnd = 1;
      snd.s1_ramping = 1;
      _level0.bkgd.vo.doRamp = 1;
      sndObjTarg = 2;
   }
   else if(snd.s2_playing && !snd.s2_ramping)
   {
      snd.fadeSnd = 2;
      snd.s2_ramping = 1;
      _level0.bkgd.vo.doRamp = 1;
      sndObjTarg = 1;
   }
   else
   {
      sndObjTarg = 1;
      _root.s1.stop();
   }
}
function doRamp()
{
   if(snd.fadeSnd == 1)
   {
      currVol = _root.s1.getVolume();
      currVol = int(currVol / 1.6);
      trace("Fading sound 1.  Volume = " + _root.s1.getVolume());
      if(currVol < 5)
      {
         _root.s1.stop();
         snd.s1_playing = 0;
         snd.fadeSnd = 0;
         snd.s1_ramping = 0;
         _level0.bkgd.vo.doRamp = 0;
      }
      else
      {
         _root.s1.setVolume(currVol);
      }
   }
   else if(snd.fadeSnd == 2)
   {
      currVol = _root.s2.getVolume();
      currVol = int(currVol / 1.6);
      trace("Fading sound 2.  Volume = " + _root.s1.getVolume());
      if(currVol < 5)
      {
         _root.s2.stop();
         snd.s2_playing = 0;
         snd.fadeSnd = 0;
         snd.s2_ramping = 0;
         _level0.bkgd.vo.doRamp = 0;
      }
      else
      {
         _root.s2.setVolume(currVol);
      }
   }
}
loadVariables("Segment1.txt","_root");
_level0.sceneStarting("SafeAndEasy");
_level0.initMusic("SafeAndEasy");
_level6.hideInner();
var holdState;
holdState = 0;
var snd = new Object();
s1 = new Sound("sound_mov1");
s2 = new Sound("sound_mov2");
snd.fadeSnd = 0;
snd.s1_playing = 0;
snd.s2_playing = 0;
snd.s1_ramping = 0;
snd.s2_ramping = 0;
snd.currVol = 100;
