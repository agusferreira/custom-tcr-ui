import React from 'react';
import PropTypes from 'prop-types';
import {bindActionCreators} from 'redux';
import * as candidateActions from '../../actions/CandidateActions';
import {connect} from 'react-redux';
import { Toolbar, ToolbarGroup, ToolbarSeparator, ToolbarTitle } from 'material-ui/Toolbar';
import CircularProgress from 'material-ui/CircularProgress';
import { EtherIcon, AdtIcon } from './Icons';
import keys from '../../i18n';
import './style.css';
import IconButton from 'material-ui/IconButton';
import RegistryIcon from 'material-ui/svg-icons/av/playlist-add';
import SettingsIcon from 'material-ui/svg-icons/action/settings';

const Header = ({ balance, onSwitcherClick, onSettingsClick }) => (
  <Toolbar className='Header'>
    <ToolbarGroup firstChild>
      <ToolbarTitle text={keys.registryName} className='HeaderTitle' />
    </ToolbarGroup>
    <ToolbarGroup>
      <EtherIcon />
      { balance.isFetchingBalance 
        ? <CircularProgress color='#fff' size={25}/>
        : <ToolbarTitle className='HeaderText' text={balance.ethers + ` ${keys.eth}`} />
      }
      <ToolbarSeparator className='Separator' />
      <AdtIcon />
      { balance.isFetchingBalance
        ? <CircularProgress color='#fff' size={25}/>
        : <ToolbarTitle className='HeaderText' text={balance.tokens + ` ${keys.tokenName}`} />
      }
      <ToolbarSeparator className='Separator' />
      <IconButton tooltip='Switch backend type' onClick={onSettingsClick}>
        <SettingsIcon color='#fff' />
      </IconButton>
      <ToolbarSeparator className='Separator' />
      <IconButton tooltip='Switch registry' onClick={onSwitcherClick}>
        <RegistryIcon color='#fff' />
      </IconButton>
    </ToolbarGroup>
  </Toolbar>
);

Header.propTypes = {
  // Sometimes web3 returns numbers as strings because they're greater than 2^53
  balance: PropTypes.object.isRequired,
  onSwitcherClick: PropTypes.func.isRequired,
  onSettingsClick: PropTypes.func.isRequired
};

function mapStateToProps (state) {
  return {
    balance: state.candidate
  };
}

function mapDispatchToProps (dispatch) {
  return {
    actions: bindActionCreators(candidateActions, dispatch)
  };
}

export default connect(mapStateToProps, mapDispatchToProps)(Header);
