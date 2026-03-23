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
function playRO(whichSnd)
{
   if(_level0.bkgd.musicOn)
   {
      if(whichSnd == "ro1")
      {
         _root.snd_ro1.start();
      }
      else if(whichSnd == "ro2")
      {
         _root.snd_ro2.start();
      }
      else if(whichSnd == "ro3")
      {
         _root.snd_ro3.start();
      }
      else if(whichSnd == "ro4")
      {
         _root.snd_ro4.start();
      }
      else if(whichSnd == "ro5")
      {
         _root.snd_ro5.start();
      }
      else if(whichSnd == "ro6")
      {
         _root.snd_ro6.start();
      }
      else if(whichSnd == "ro7")
      {
         _root.snd_ro7.start();
      }
      else if(whichSnd == "ro8")
      {
         _root.snd_ro8.start();
      }
   }
}
function rampOutRO(whichSnd)
{
   if(_level0.bkgd.musicOn)
   {
      if(whichSnd == "ro1")
      {
         _level0.bkgd.vo.doRamp = 1;
         snd.rampRO1 = 1;
      }
      else if(whichSnd == "ro2")
      {
         _level0.bkgd.vo.doRamp = 1;
         snd.rampRO2 = 1;
      }
      else if(whichSnd == "ro3")
      {
         _level0.bkgd.vo.doRamp = 1;
         snd.rampRO3 = 1;
      }
      else if(whichSnd == "ro4")
      {
         _level0.bkgd.vo.doRamp = 1;
         snd.rampRO4 = 1;
      }
      else if(whichSnd == "ro5")
      {
         _level0.bkgd.vo.doRamp = 1;
         snd.rampRO5 = 1;
      }
      else if(whichSnd == "ro6")
      {
         _level0.bkgd.vo.doRamp = 1;
         snd.rampRO6 = 1;
      }
      else if(whichSnd == "ro7")
      {
         _level0.bkgd.vo.doRamp = 1;
         snd.rampRO7 = 1;
      }
      else if(whichSnd == "ro8")
      {
         _level0.bkgd.vo.doRamp = 1;
         snd.rampRO8 = 1;
      }
   }
}
function checkRampRO()
{
   var sndIncrement;
   sndIncrement = 1.1;
   var endVolume;
   endVolume = 100;
   if(snd.rampRO1)
   {
      trace("ramping sound 1.  Current volume = " + _root.snd_ro1.getVolume());
      currVol = _root.snd_ro1.getVolume();
      currVol = int(currVol / sndIncrement);
      if(currVol < 5)
      {
         _root.snd_ro1.stop();
         _root.snd_ro1.setVolume(endVolume);
         snd.rampRO1 = 0;
      }
      else
      {
         _root.snd_ro1.setVolume(currVol);
      }
   }
   if(snd.rampRO2)
   {
      trace("ramping sound 2.  Current volume = " + _root.snd_ro2.getVolume());
      currVol = _root.snd_ro2.getVolume();
      currVol = int(currVol / sndIncrement);
      if(currVol < 5)
      {
         _root.snd_ro2.stop();
         _root.snd_ro2.setVolume(endVolume);
         snd.rampRO2 = 0;
      }
      else
      {
         _root.snd_ro2.setVolume(currVol);
      }
   }
   if(snd.rampRO3)
   {
      trace("ramping sound 3.  Current volume = " + _root.snd_ro3.getVolume());
      currVol = _root.snd_ro3.getVolume();
      currVol = int(currVol / sndIncrement);
      if(currVol < 5)
      {
         _root.snd_ro3.stop();
         _root.snd_ro3.setVolume(endVolume);
         snd.rampRO3 = 0;
      }
      else
      {
         _root.snd_ro3.setVolume(currVol);
      }
   }
   if(snd.rampRO4)
   {
      currVol = _root.snd_ro4.getVolume();
      currVol = int(currVol / sndIncrement);
      if(currVol < 5)
      {
         _root.snd_ro4.stop();
         _root.snd_ro4.setVolume(endVolume);
         snd.rampRO4 = 0;
      }
      else
      {
         _root.snd_ro4.setVolume(currVol);
      }
   }
   if(snd.rampRO5)
   {
      currVol = _root.snd_ro5.getVolume();
      currVol = int(currVol / sndIncrement);
      if(currVol < 5)
      {
         _root.snd_ro5.stop();
         _root.snd_ro5.setVolume(endVolume);
         snd.rampRO5 = 0;
      }
      else
      {
         _root.snd_ro5.setVolume(currVol);
      }
   }
   if(snd.rampRO6)
   {
      currVol = _root.snd_ro6.getVolume();
      currVol = int(currVol / sndIncrement);
      if(currVol < 5)
      {
         _root.snd_ro6.stop();
         _root.snd_ro6.setVolume(endVolume);
         snd.rampRO6 = 0;
      }
      else
      {
         _root.snd_ro6.setVolume(currVol);
      }
   }
   if(snd.rampRO7)
   {
      currVol = _root.snd_ro7.getVolume();
      currVol = int(currVol / sndIncrement);
      if(currVol < 5)
      {
         _root.snd_ro7.stop();
         _root.snd_ro7.setVolume(endVolume);
         snd.rampRO7 = 0;
      }
      else
      {
         _root.snd_ro7.setVolume(currVol);
      }
   }
   if(snd.rampRO8)
   {
      currVol = _root.snd_ro8.getVolume();
      currVol = int(currVol / sndIncrement);
      if(currVol < 5)
      {
         _root.snd_ro8.stop();
         _root.snd_ro8.setVolume(endVolume);
         snd.rampRO8 = 0;
      }
      else
      {
         _root.snd_ro8.setVolume(currVol);
      }
   }
}
function doRamp()
{
   checkRampRO();
   if(snd.fadeSnd == 1)
   {
      snd.currVol = int(snd.currVol / 1.6);
      if(snd.currVol < 5)
      {
         _root.s1.stop();
         snd.s1_playing = 0;
         snd.fadeSnd = 0;
         snd.s1_ramping = 0;
         _level0.bkgd.vo.doRamp = 0;
         snd.currVol = 100;
      }
      else
      {
         _root.s1.setVolume(snd.currVol);
      }
   }
   else if(snd.fadeSnd == 2)
   {
      snd.currVol = int(snd.currVol / 1.6);
      if(vol < 5)
      {
         _root.s2.stop();
         snd.s2_playing = 0;
         snd.fadeSnd = 0;
         snd.s2_ramping = 0;
         _level0.bkgd.vo.doRamp = 0;
         snd.currVol = 100;
      }
      else
      {
         _root.s2.setVolume(snd.currVol);
      }
   }
}
var snd = new Object();
s1 = new Sound("sound_mov1");
s2 = new Sound("sound_mov2");
snd_ro1 = new Sound("sound_mov_ro1");
snd_ro2 = new Sound("sound_mov_ro2");
snd_ro3 = new Sound("sound_mov_ro3");
snd_ro4 = new Sound("sound_mov_ro4");
snd_ro5 = new Sound("sound_mov_ro5");
snd_ro6 = new Sound("sound_mov_ro6");
snd_ro7 = new Sound("sound_mov_ro7");
snd_ro8 = new Sound("sound_mov_ro8");
snd_ro1.attachSound("ro1");
snd_ro2.attachSound("ro2");
snd_ro3.attachSound("ro3");
snd_ro4.attachSound("ro4");
snd_ro5.attachSound("ro5");
snd_ro6.attachSound("ro6");
snd_ro7.attachSound("ro7");
snd_ro8.attachSound("ro8");
snd.fadeSnd = 0;
snd.s1_playing = 0;
snd.s2_playing = 0;
snd.s1_ramping = 0;
snd.s2_ramping = 0;
snd.rampRO1 = 0;
snd.rampRO2 = 0;
snd.rampRO3 = 0;
snd.rampRO4 = 0;
snd.rampRO5 = 0;
snd.rampRO6 = 0;
snd.rampRO7 = 0;
snd.rampRO8 = 0;
snd.currVol = 100;
